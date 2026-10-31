import "dotenv/config";
import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { execFile } from "node:child_process";
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
import { cleanupStaleDownloadDirs, detectPlatform, YT_DLP_PATH } from "./utils/downloader.js";
import { startMtprotoSender, stopMtprotoSender } from "./utils/mtproto-sender.js";

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
      throw err;
    }
  } else {
    await new Promise<void>((resolve) => {
      execFile(YT_DLP_PATH, ["-U"], { timeout: 120_000 }, (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim().slice(0, 120);
        if (err) logger.warn({ err }, "yt-dlp update failed; keeping the installed version");
        else logger.info({ msg: output }, "yt-dlp update check done");
        resolve();
      });
    });
  }
}

const cairoDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function cairoParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(
    cairoDateTime.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value])
  );
}

function cairoMidnightUtc(localDateUtc: number): number {
  const date = new Date(localDateUtc);
  const targetLocalAsUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0
  );
  let candidate = targetLocalAsUtc;

  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = cairoParts(candidate);
    const representedLocalAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const correction = representedLocalAsUtc - targetLocalAsUtc;
    candidate -= correction;
    if (correction === 0) break;
  }

  return candidate;
}

function nextFridayMidnightCairo(now = Date.now()): number {
  const parts = cairoParts(now);
  const todayUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const weekday = new Date(todayUtc).getUTCDay();
  const daysUntilFriday = (5 - weekday + 7) % 7;
  let scheduled = cairoMidnightUtc(todayUtc + daysUntilFriday * 24 * 60 * 60 * 1000);

  if (scheduled <= now) {
    scheduled = cairoMidnightUtc(todayUtc + (daysUntilFriday + 7) * 24 * 60 * 60 * 1000);
  }

  return scheduled;
}

function scheduleWeeklyYtDlpUpdate(): void {
  const scheduledAt = nextFridayMidnightCairo();
  logger.info({ scheduledAt: new Date(scheduledAt).toISOString() }, "Scheduled weekly yt-dlp update check");

  const timer = setTimeout(() => {
    void (async () => {
      logger.info("Starting weekly yt-dlp update check");
      try {
        await ensureYtDlp();
      } catch (err) {
        logger.warn({ err }, "Weekly yt-dlp update failed; keeping the bot running");
      } finally {
        scheduleWeeklyYtDlpUpdate();
      }
    })();
  }, Math.max(0, scheduledAt - Date.now()));

  timer.unref();
}

// ── Regexes ───────────────────────────────────────────────────────────────

const URL_CANDIDATE_REGEX = /https?:\/\/[^\s<>"']+/gi;

const YT_CMD_REGEX = /^\/k_([A-Za-z0-9_]{5,20})$/;

const DEFAULT_WELCOME =
  `👋 <b>أهلاً وسهلاً!</b>\n\n` +
  `🎬 <b>بوت تحميل الفيديوهات</b>\n\n` +
  `أرسل رابطاً من:\n` +
  `🔴 يوتيوب • 🎵 تيك توك • 🔵 فيسبوك • 📸 إنستجرام\n` +
  `👻 سناب شات • 𝕏 X • 📌 Pinterest • 🎧 SoundCloud\n\n` +
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

function extractSupportedUrl(text: string): string | undefined {
  const candidates = text.match(URL_CANDIDATE_REGEX) ?? [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),.!?؛،]+$/u, "");
    if (detectPlatform(cleaned) !== "unknown") return cleaned;
  }
  return undefined;
}

// ── Bot startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env["BOT_TOKEN"];
  if (!token) { logger.error("BOT_TOKEN is not set — check your .env file"); process.exit(1); }

  const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
  const bot = new Telegraf(token);

  const me = await bot.telegram.getMe();
  setBotUsername(me.username ?? "YourBot");
  logger.info({ username: me.username }, "Bot identity fetched");
  const mtprotoReady = await startMtprotoSender(me.id);
  if (mtprotoReady) logger.info("MTProto media sender is ready for this bot identity");
  else logger.warn("MTProto media sending is disabled until TELEGRAM_API_ID and TELEGRAM_API_HASH are configured");

  await cleanupStaleDownloadDirs();
  await ensureYtDlp();

  // throttle: لا نكتب للـ DB إلا كل 5 دقائق لنفس المستخدم
  const recentlyUpserted = new Map<number, number>();
  const userUpsertsInFlight = new Set<number>();
  const UPSERT_TTL = 5 * 60 * 1000;

  // ── 1. User registration + ban check ────────────────────────────────────
  bot.use(async (ctx: Context, next) => {
    if (ctx.from) {
      const now = Date.now();
      const lastUpsert = recentlyUpserted.get(ctx.from.id) ?? 0;
      if (now - lastUpsert > UPSERT_TTL && !userUpsertsInFlight.has(ctx.from.id)) {
        const user = ctx.from;
        userUpsertsInFlight.add(user.id);
        void upsertUser({
          id:           user.id,
          username:     user.username,
          firstName:    user.first_name,
          lastName:     user.last_name,
          languageCode: user.language_code,
        }).then(() => {
          recentlyUpserted.set(user.id, Date.now());
        }).catch((err) => {
          logger.warn({ err, userId: user.id }, "User registration failed; it will be retried");
        }).finally(() => {
          userUpsertsInFlight.delete(user.id);
        });
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
      `🔴 YouTube • 🎵 TikTok • 🔵 Facebook • 📸 Instagram\n👻 Snapchat • X • Pinterest • SoundCloud`,
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

      let channels: Awaited<ReturnType<typeof getActiveChannels>>;
      try {
        channels = await getActiveChannels();
      } catch (err) {
        logger.warn({ err }, "Could not load required channels for subscription check");
        await ctx.answerCbQuery("تعذر التحقق الآن، أعد المحاولة بعد قليل");
        return;
      }
      const notSub: typeof channels = [];
      const results = await Promise.allSettled(
        channels.map((ch) => ctx.telegram.getChatMember(ch.channelId, userId))
      );
      if (results.some((result) => result.status === "rejected")) {
        logger.warn({ userId }, "Required-channel callback membership check failed");
        await ctx.answerCbQuery("تعذر التحقق الآن، تأكد من صلاحية البوت ثم أعد المحاولة");
        return;
      }
      for (let i = 0; i < channels.length; i++) {
        const result = results[i]!;
        if (result.status === "fulfilled" && (
          result.value.status === "left" ||
          result.value.status === "kicked" ||
          (result.value.status === "restricted" && !result.value.is_member)
        )) {
          notSub.push(channels[i]!);
        }
      }

      if (notSub.length === 0) {
        await ctx.answerCbQuery("✅ تم التحقق من الاشتراك، يمكنك الآن استخدام البوت");
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

    const url = extractSupportedUrl(text);
    if (url) { await handleUrl(ctx, url); return; }
    if (/https?:\/\/[^\s<>"']/i.test(text)) {
      await ctx.reply("❌ هذا الرابط غير مدعوم حاليًا. أرسل رابطًا من المواقع الظاهرة في /help");
      return;
    }

    await handleSearch(ctx, text);
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.catch((err: unknown) => { logger.error({ err }, "Bot error"); });

  // ── Launch ────────────────────────────────────────────────────────────────
  scheduleWeeklyYtDlpUpdate();

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    bot.stop(signal);
    void stopMtprotoSender();
  };
  process.once("SIGINT",  () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  setInterval(() => {
    void cleanupStaleDownloadDirs().catch((err) => {
      logger.warn({ err }, "Failed to clean stale download folders");
    });
  }, 60 * 60 * 1000);

  const throttleMapCleanup = setInterval(() => {
    const expiredBefore = Date.now() - UPSERT_TTL * 2;
    for (const [userId, lastUpsert] of recentlyUpserted) {
      if (lastUpsert < expiredBefore) recentlyUpserted.delete(userId);
    }
  }, 60 * 60 * 1000);
  throttleMapCleanup.unref();

  void bot.launch({ allowedUpdates: ["message", "callback_query"] }).catch((err) => {
    logger.error({ err }, "Telegram bot polling failed");
    process.exit(1);
  });
  logger.info("Telegram bot polling startup requested");
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  void (async () => {
    await stopMtprotoSender().catch(() => {});
    process.exit(1);
  })();
});
