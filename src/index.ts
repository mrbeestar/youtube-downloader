import "dotenv/config";
import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { exec } from "node:child_process";
import https from "node:https";
import http from "node:http";
import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { upsertUser, isAdmin, isUserBanned, getSettings, getActiveChannels } from "./db.js";
import { checkSubscription } from "./middleware/subscription.js";
import { handleUrl, handleDownloadCallback, setBotUsername } from "./handlers/download.js";
import { sendAdminPanel, handleAdminCallback, handleAwaitingInput } from "./handlers/admin.js";
import { handleSearch, handleSearchPage, handleKCommand } from "./handlers/search.js";
import { logger } from "./logger.js";
import { YT_DLP_PATH } from "./utils/downloader.js";

// ── yt-dlp auto-install ───────────────────────────────────────────────────

function downloadFile(url: string, dest: string, redirects = 8): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        if (redirects <= 0) { reject(new Error("Too many redirects")); return; }
        downloadFile(res.headers.location, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function ensureYtDlp(): Promise<void> {
  const dir = dirname(YT_DLP_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(YT_DLP_PATH)) {
    logger.info({ path: YT_DLP_PATH }, "yt-dlp not found — installing automatically...");
    try {
      await downloadFile(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
        YT_DLP_PATH
      );
      chmodSync(YT_DLP_PATH, 0o755);
      logger.info("yt-dlp installed successfully");
    } catch (err) {
      logger.error({ err }, "Failed to auto-install yt-dlp — install it manually");
    }
  } else {
    exec(`${YT_DLP_PATH} -U`, (err, stdout) => {
      if (err) logger.warn({ err }, "yt-dlp update failed (non-fatal)");
      else logger.info({ msg: stdout.trim().slice(0, 120) }, "yt-dlp update check done");
    });
  }
}

// ── Regexes ───────────────────────────────────────────────────────────────

const URL_REGEX =
  /https?:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|fb\.com|fb\.watch|instagram\.com|snapchat\.com|snap\.com|vm\.tiktok\.com|vt\.tiktok\.com)[^\s]*/gi;

const YT_CMD_REGEX = /^\/k_([A-Za-z0-9_]{5,20})$/;

const DEFAULT_WELCOME =
  `👋 <b>أهلاً وسهلاً!</b>\n\n` +
  `🎬 <b>بوت تحميل الفيديوهات</b>\n\n` +
  `أرسل رابطاً من:\n` +
  `🔴 يوتيوب • 🎵 تيك توك • 🔵 فيسبوك\n` +
  `📸 إنستجرام • 👻 سناب شات\n\n` +
  `أو ابحث مباشرةً بكتابة اسم الأغنية أو الفيديو 🔍\n\n` +
  `✅ جودات متعددة | ✅ ستوريهات | ✅ بدون علامة مائية | ✅ MP3`;

// ── Helpers ───────────────────────────────────────────────────────────────

function detectParseMode(text: string): "HTML" | "MarkdownV2" | undefined {
  if (/<(b|i|u|s|a|code|pre|tg-spoiler)\b/i.test(text)) return "HTML";
  if (/(?<![\\])[*_`\[\]~|]/.test(text)) return "MarkdownV2";
  return undefined;
}

function resolveTemplateVars(
  text: string,
  from: { id: number; first_name: string; username?: string },
  parseMode: "HTML" | "MarkdownV2" | undefined
): string {
  const name    = from.first_name || "مستخدم";
  const userId  = String(from.id);

  let usernameDisplay: string;
  if (from.username) {
    if (parseMode === "HTML")
      usernameDisplay = `<a href="tg://user?id=${from.id}">@${from.username}</a>`;
    else if (parseMode === "MarkdownV2")
      usernameDisplay = `[@${from.username}](tg://user?id=${from.id})`;
    else
      usernameDisplay = `@${from.username}`;
  } else {
    if (parseMode === "HTML")
      usernameDisplay = `<a href="tg://user?id=${from.id}">${name}</a>`;
    else if (parseMode === "MarkdownV2")
      usernameDisplay = `[${name}](tg://user?id=${from.id})`;
    else
      usernameDisplay = name;
  }

  return text
    .replace(/#name/g,     name)
    .replace(/#username/g, usernameDisplay)
    .replace(/#userid/g,   userId);
}

// ── Bot startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env["BOT_TOKEN"];
  if (!token) { logger.error("BOT_TOKEN is not set — check your .env file"); process.exit(1); }

  const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
  const bot     = new Telegraf(token);

  const me = await bot.telegram.getMe();
  setBotUsername(me.username ?? "YourBot");
  logger.info({ username: me.username }, "Bot identity fetched");

  await ensureYtDlp();

  // throttle: لا نكتب للـ DB إلا كل 5 دقائق لنفس المستخدم
  const recentlyUpserted = new Map<number, number>();
  const UPSERT_TTL = 5 * 60 * 1000;

  // ── 1. User registration + ban check ────────────────────────────────────
  bot.use(async (ctx: Context, next) => {
    if (ctx.from) {
      const now = Date.now();
      const lastUpsert = recentlyUpserted.get(ctx.from.id) ?? 0;
      if (now - lastUpsert > UPSERT_TTL) {
        recentlyUpserted.set(ctx.from.id, now);
        upsertUser({
          id:           ctx.from.id,
          username:     ctx.from.username,
          firstName:    ctx.from.first_name,
          lastName:     ctx.from.last_name,
          languageCode: ctx.from.language_code,
        }).catch(() => {});
      }

      const banned = await isUserBanned(ctx.from.id).catch(() => false);
      if (banned) {
        await ctx.reply("🚫 أنت محظور من استخدام هذا البوت").catch(() => {});
        return;
      }
    }
    return next();
  });

  // ── 2. Subscription check ────────────────────────────────────────────────
  bot.use(checkSubscription);

  // ── 3. Admin commands ────────────────────────────────────────────────────
  bot.command(["panel", "admin"], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (userId !== ownerId && !(await isAdmin(userId))) {
      await ctx.reply("⛔ ليس لديك صلاحية");
      return;
    }
    await sendAdminPanel(ctx);
  });

  // ── 4. /start ────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const userId  = ctx.from?.id;
    const payload = ctx.startPayload;

    const settings  = await getSettings();
    const raw       = settings["welcome_message"] || DEFAULT_WELCOME;
    const parseMode = detectParseMode(raw);
    const welcomeText = ctx.from
      ? resolveTemplateVars(raw, ctx.from, parseMode)
      : raw;

    if (userId && (userId === ownerId || (await isAdmin(userId)))) {
      await sendAdminPanel(ctx);
    }

    await ctx.reply(welcomeText, { parse_mode: parseMode }).catch(async () => {
      await ctx.reply(welcomeText);
    });
  });

  // ── 5. /help ─────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    await ctx.reply(
      `📖 <b>طريقة الاستخدام:</b>\n\n` +
      `<b>📥 تحميل بالرابط:</b>\n` +
      `أرسل رابط الفيديو مباشرةً\n\n` +
      `<b>🔍 بحث في يوتيوب:</b>\n` +
      `اكتب اسم الأغنية أو الفيديو\n` +
      `ثم اضغط على معرف الفيديو /k_... لتحميله\n\n` +
      `<b>📌 المواقع المدعومة:</b>\n` +
      `🔴 YouTube • 🎵 TikTok • 🔵 Facebook\n📸 Instagram • 👻 Snapchat`,
      { parse_mode: "HTML" }
    );
  });

  // ── 6. Callback queries ───────────────────────────────────────────────────
  bot.on("callback_query", async (ctx) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";

    if (data === "cancel") {
      await ctx.answerCbQuery("تم الإلغاء");
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === "check:sub") {
      const userId = ctx.from?.id;
      if (!userId) { await ctx.answerCbQuery(); return; }

      const channels = await getActiveChannels();
      const notSub: typeof channels = [];

      for (const ch of channels) {
        try {
          const m = await ctx.telegram.getChatMember(ch.channelId, userId);
          if (m.status === "left" || m.status === "kicked") notSub.push(ch);
        } catch {}
      }

      if (notSub.length === 0) {
        await ctx.answerCbQuery("✅ تم التحقق! يمكنك الآن استخدام البوت");
        await ctx.deleteMessage().catch(() => {});
      } else {
        await ctx.answerCbQuery("❌ لم تشترك بعد في جميع القنوات!");
      }
      return;
    }

    if (data.startsWith("srch:p:")) {
      const page = parseInt(data.replace("srch:p:", ""), 10);
      await handleSearchPage(ctx, page);
      return;
    }

    if (data.startsWith("dl:")) {
      const parts = data.split(":");
      await handleDownloadCallback(ctx, parts[1]!, parts.slice(2).join(":"));
      return;
    }

    if (data.startsWith("admin:")) {
      await handleAdminCallback(ctx, data.replace("admin:", ""));
      return;
    }
  });

  // ── 7. Text messages ──────────────────────────────────────────────────────
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();

    const handled = await handleAwaitingInput(ctx);
    if (handled) return;

    const ytMatch = text.match(YT_CMD_REGEX);
    if (ytMatch) {
      await handleKCommand(ctx, ytMatch[1]!);
      return;
    }

    if (text.startsWith("/")) return;

    const urlMatches = text.match(URL_REGEX);
    if (urlMatches?.length) { await handleUrl(ctx, urlMatches[0]!); return; }

    await handleSearch(ctx, text);
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.catch((err: unknown) => { logger.error({ err }, "Bot error"); });

  // ── Launch ────────────────────────────────────────────────────────────────
  await bot.launch({ allowedUpdates: ["message", "callback_query"] });
  logger.info("Telegram bot started (polling)");

  // ── تحديث yt-dlp كل 7 أيام تلقائياً ────────────────────────────────────
  setInterval(() => {
    exec("bash scripts/install-yt-dlp.sh", (err) => {
      if (!err) logger.info("✅ yt-dlp تم تحديثه تلقائياً");
      else logger.warn({ err }, "⚠️ فشل تحديث yt-dlp");
    });
  }, 7 * 24 * 60 * 60 * 1000);

  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
