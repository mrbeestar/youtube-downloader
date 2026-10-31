"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const telegraf_1 = require("telegraf");
const filters_1 = require("telegraf/filters");
const node_child_process_1 = require("node:child_process");
const node_https_1 = __importDefault(require("node:https"));
const node_http_1 = __importDefault(require("node:http"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const db_js_1 = require("./db.js");
const subscription_js_1 = require("./middleware/subscription.js");
const download_js_1 = require("./handlers/download.js");
const admin_js_1 = require("./handlers/admin.js");
const search_js_1 = require("./handlers/search.js");
const logger_js_1 = require("./logger.js");
const downloader_js_1 = require("./utils/downloader.js");
const mtproto_sender_js_1 = require("./utils/mtproto-sender.js");
// ── yt-dlp auto-install ───────────────────────────────────────────────────
function downloadFile(url, dest, redirects = 8) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith("https") ? node_https_1.default : node_http_1.default;
        proto.get(url, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                if (redirects <= 0) {
                    reject(new Error("Too many redirects"));
                    return;
                }
                downloadFile(res.headers.location, dest, redirects - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const file = (0, node_fs_1.createWriteStream)(dest);
            res.pipe(file);
            file.on("finish", () => { file.close(); resolve(); });
            file.on("error", reject);
        }).on("error", reject);
    });
}
async function ensureYtDlp() {
    const dir = (0, node_path_1.dirname)(downloader_js_1.YT_DLP_PATH);
    if (!(0, node_fs_1.existsSync)(dir))
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    if (!(0, node_fs_1.existsSync)(downloader_js_1.YT_DLP_PATH)) {
        logger_js_1.logger.info({ path: downloader_js_1.YT_DLP_PATH }, "yt-dlp not found — installing automatically...");
        try {
            await downloadFile("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp", downloader_js_1.YT_DLP_PATH);
            (0, node_fs_1.chmodSync)(downloader_js_1.YT_DLP_PATH, 0o755);
            logger_js_1.logger.info("yt-dlp installed successfully");
        }
        catch (err) {
            logger_js_1.logger.error({ err }, "Failed to auto-install yt-dlp — install it manually");
            throw err;
        }
    }
    else {
        await new Promise((resolve) => {
            (0, node_child_process_1.execFile)(downloader_js_1.YT_DLP_PATH, ["-U"], { timeout: 120_000 }, (err, stdout, stderr) => {
                const output = `${stdout}\n${stderr}`.trim().slice(0, 120);
                if (err)
                    logger_js_1.logger.warn({ err }, "yt-dlp update failed; keeping the installed version");
                else
                    logger_js_1.logger.info({ msg: output }, "yt-dlp update check done");
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
function cairoParts(timestamp) {
    return Object.fromEntries(cairoDateTime.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
}
function cairoMidnightUtc(localDateUtc) {
    const date = new Date(localDateUtc);
    const targetLocalAsUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0);
    let candidate = targetLocalAsUtc;
    for (let attempt = 0; attempt < 3; attempt++) {
        const parts = cairoParts(candidate);
        const representedLocalAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
        const correction = representedLocalAsUtc - targetLocalAsUtc;
        candidate -= correction;
        if (correction === 0)
            break;
    }
    return candidate;
}
function nextFridayMidnightCairo(now = Date.now()) {
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
function scheduleWeeklyYtDlpUpdate() {
    const scheduledAt = nextFridayMidnightCairo();
    logger_js_1.logger.info({ scheduledAt: new Date(scheduledAt).toISOString() }, "Scheduled weekly yt-dlp update check");
    const timer = setTimeout(() => {
        void (async () => {
            logger_js_1.logger.info("Starting weekly yt-dlp update check");
            try {
                await ensureYtDlp();
            }
            catch (err) {
                logger_js_1.logger.warn({ err }, "Weekly yt-dlp update failed; keeping the bot running");
            }
            finally {
                scheduleWeeklyYtDlpUpdate();
            }
        })();
    }, Math.max(0, scheduledAt - Date.now()));
    timer.unref();
}
// ── Regexes ───────────────────────────────────────────────────────────────
const URL_CANDIDATE_REGEX = /https?:\/\/[^\s<>"']+/gi;
const YT_CMD_REGEX = /^\/k_([A-Za-z0-9_]{5,20})$/;
const DEFAULT_WELCOME = `👋 <b>أهلاً وسهلاً!</b>\n\n` +
    `🎬 <b>بوت تحميل الفيديوهات</b>\n\n` +
    `أرسل رابطاً من:\n` +
    `🔴 يوتيوب • 🎵 تيك توك • 🔵 فيسبوك • 📸 إنستجرام\n` +
    `👻 سناب شات • 𝕏 X • 📌 Pinterest • 🎧 SoundCloud\n\n` +
    `أو ابحث مباشرةً بكتابة اسم الأغنية أو الفيديو 🔍\n\n` +
    `✅ جودات متعددة | ✅ ستوريهات | ✅ بدون علامة مائية | ✅ MP3`;
// ── Helpers ───────────────────────────────────────────────────────────────
function detectParseMode(text) {
    if (/<(b|i|u|s|a|code|pre|tg-spoiler)\b/i.test(text))
        return "HTML";
    if (/(?<![\\])[*_`\[\]~|]/.test(text))
        return "MarkdownV2";
    return undefined;
}
function resolveTemplateVars(text, from, parseMode) {
    const name = from.first_name || "مستخدم";
    const userId = String(from.id);
    let usernameDisplay;
    if (from.username) {
        if (parseMode === "HTML")
            usernameDisplay = `<a href="tg://user?id=${from.id}">@${from.username}</a>`;
        else if (parseMode === "MarkdownV2")
            usernameDisplay = `[@${from.username}](tg://user?id=${from.id})`;
        else
            usernameDisplay = `@${from.username}`;
    }
    else {
        if (parseMode === "HTML")
            usernameDisplay = `<a href="tg://user?id=${from.id}">${name}</a>`;
        else if (parseMode === "MarkdownV2")
            usernameDisplay = `[${name}](tg://user?id=${from.id})`;
        else
            usernameDisplay = name;
    }
    return text
        .replace(/#name/g, name)
        .replace(/#username/g, usernameDisplay)
        .replace(/#userid/g, userId);
}
function extractSupportedUrl(text) {
    const candidates = text.match(URL_CANDIDATE_REGEX) ?? [];
    for (const candidate of candidates) {
        const cleaned = candidate.replace(/[),.!?؛،]+$/u, "");
        if ((0, downloader_js_1.detectPlatform)(cleaned) !== "unknown")
            return cleaned;
    }
    return undefined;
}
// ── Bot startup ───────────────────────────────────────────────────────────
async function main() {
    const token = process.env["BOT_TOKEN"];
    if (!token) {
        logger_js_1.logger.error("BOT_TOKEN is not set — check your .env file");
        process.exit(1);
    }
    const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
    const bot = new telegraf_1.Telegraf(token);
    const me = await bot.telegram.getMe();
    (0, download_js_1.setBotUsername)(me.username ?? "YourBot");
    logger_js_1.logger.info({ username: me.username }, "Bot identity fetched");
    const mtprotoReady = await (0, mtproto_sender_js_1.startMtprotoSender)(me.id);
    if (mtprotoReady)
        logger_js_1.logger.info("MTProto media sender is ready for this bot identity");
    else
        logger_js_1.logger.warn("MTProto media sending is disabled until TELEGRAM_API_ID and TELEGRAM_API_HASH are configured");
    await (0, downloader_js_1.cleanupStaleDownloadDirs)();
    await ensureYtDlp();
    // throttle: لا نكتب للـ DB إلا كل 5 دقائق لنفس المستخدم
    const recentlyUpserted = new Map();
    const userUpsertsInFlight = new Set();
    const UPSERT_TTL = 5 * 60 * 1000;
    // ── 1. User registration + ban check ────────────────────────────────────
    bot.use(async (ctx, next) => {
        if (ctx.from) {
            const now = Date.now();
            const lastUpsert = recentlyUpserted.get(ctx.from.id) ?? 0;
            if (now - lastUpsert > UPSERT_TTL && !userUpsertsInFlight.has(ctx.from.id)) {
                const user = ctx.from;
                userUpsertsInFlight.add(user.id);
                void (0, db_js_1.upsertUser)({
                    id: user.id,
                    username: user.username,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    languageCode: user.language_code,
                }).then(() => {
                    recentlyUpserted.set(user.id, Date.now());
                }).catch((err) => {
                    logger_js_1.logger.warn({ err, userId: user.id }, "User registration failed; it will be retried");
                }).finally(() => {
                    userUpsertsInFlight.delete(user.id);
                });
            }
            const banned = await (0, db_js_1.isUserBanned)(ctx.from.id).catch(() => false);
            if (banned) {
                await ctx.reply("🚫 أنت محظور من استخدام هذا البوت").catch(() => { });
                return;
            }
        }
        return next();
    });
    // ── 2. Subscription check ────────────────────────────────────────────────
    bot.use(subscription_js_1.checkSubscription);
    // ── 3. Admin commands ────────────────────────────────────────────────────
    bot.command(["panel", "admin"], async (ctx) => {
        const userId = ctx.from?.id;
        if (!userId)
            return;
        if (userId !== ownerId && !(await (0, db_js_1.isAdmin)(userId))) {
            await ctx.reply("⛔ ليس لديك صلاحية");
            return;
        }
        await (0, admin_js_1.sendAdminPanel)(ctx);
    });
    // ── 4. /start ────────────────────────────────────────────────────────────
    bot.start(async (ctx) => {
        const userId = ctx.from?.id;
        const settings = await (0, db_js_1.getSettings)();
        const raw = settings["welcome_message"] || DEFAULT_WELCOME;
        const parseMode = detectParseMode(raw);
        const welcomeText = ctx.from
            ? resolveTemplateVars(raw, ctx.from, parseMode)
            : raw;
        if (userId && (userId === ownerId || (await (0, db_js_1.isAdmin)(userId)))) {
            await (0, admin_js_1.sendAdminPanel)(ctx);
        }
        await ctx.reply(welcomeText, { parse_mode: parseMode }).catch(async () => {
            await ctx.reply(welcomeText);
        });
    });
    // ── 5. /help ─────────────────────────────────────────────────────────────
    bot.help(async (ctx) => {
        await ctx.reply(`📖 <b>طريقة الاستخدام:</b>\n\n` +
            `<b>📥 تحميل بالرابط:</b>\n` +
            `أرسل رابط الفيديو مباشرةً\n\n` +
            `<b>🔍 بحث في يوتيوب:</b>\n` +
            `اكتب اسم الأغنية أو الفيديو\n` +
            `ثم اضغط على معرف الفيديو /k_... لتحميله\n\n` +
            `<b>📌 المواقع المدعومة:</b>\n` +
            `🔴 YouTube • 🎵 TikTok • 🔵 Facebook • 📸 Instagram\n👻 Snapchat • X • Pinterest • SoundCloud`, { parse_mode: "HTML" });
    });
    // ── 6. Callback queries ───────────────────────────────────────────────────
    bot.on("callback_query", async (ctx) => {
        const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
        if (data === "cancel") {
            await ctx.answerCbQuery("تم الإلغاء");
            await ctx.deleteMessage().catch(() => { });
            return;
        }
        if (data === "check:sub") {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.answerCbQuery();
                return;
            }
            let channels;
            try {
                channels = await (0, db_js_1.getActiveChannels)();
            }
            catch (err) {
                logger_js_1.logger.warn({ err }, "Could not load required channels for subscription check");
                await ctx.answerCbQuery("تعذر التحقق الآن، أعد المحاولة بعد قليل");
                return;
            }
            const notSub = [];
            const results = await Promise.allSettled(channels.map((ch) => ctx.telegram.getChatMember(ch.channelId, userId)));
            if (results.some((result) => result.status === "rejected")) {
                logger_js_1.logger.warn({ userId }, "Required-channel callback membership check failed");
                await ctx.answerCbQuery("تعذر التحقق الآن، تأكد من صلاحية البوت ثم أعد المحاولة");
                return;
            }
            for (let i = 0; i < channels.length; i++) {
                const result = results[i];
                if (result.status === "fulfilled" && (result.value.status === "left" ||
                    result.value.status === "kicked" ||
                    (result.value.status === "restricted" && !result.value.is_member))) {
                    notSub.push(channels[i]);
                }
            }
            if (notSub.length === 0) {
                await ctx.answerCbQuery("✅ تم التحقق من الاشتراك، يمكنك الآن استخدام البوت");
                await ctx.deleteMessage().catch(() => { });
            }
            else {
                await ctx.answerCbQuery("❌ لم تشترك بعد في جميع القنوات!");
            }
            return;
        }
        if (data.startsWith("srch:p:")) {
            const page = parseInt(data.replace("srch:p:", ""), 10);
            await (0, search_js_1.handleSearchPage)(ctx, page);
            return;
        }
        if (data.startsWith("dl:")) {
            const parts = data.split(":");
            await (0, download_js_1.handleDownloadCallback)(ctx, parts[1], parts.slice(2).join(":"));
            return;
        }
        if (data.startsWith("admin:")) {
            await (0, admin_js_1.handleAdminCallback)(ctx, data.replace("admin:", ""));
            return;
        }
    });
    // ── 7. Text messages ──────────────────────────────────────────────────────
    bot.on((0, filters_1.message)("text"), async (ctx) => {
        const text = ctx.message.text.trim();
        const handled = await (0, admin_js_1.handleAwaitingInput)(ctx);
        if (handled)
            return;
        const ytMatch = text.match(YT_CMD_REGEX);
        if (ytMatch) {
            await (0, search_js_1.handleKCommand)(ctx, ytMatch[1]);
            return;
        }
        if (text.startsWith("/"))
            return;
        const url = extractSupportedUrl(text);
        if (url) {
            await (0, download_js_1.handleUrl)(ctx, url);
            return;
        }
        if (/https?:\/\/[^\s<>"']/i.test(text)) {
            await ctx.reply("❌ هذا الرابط غير مدعوم حاليًا. أرسل رابطًا من المواقع الظاهرة في /help");
            return;
        }
        await (0, search_js_1.handleSearch)(ctx, text);
    });
    // ── Error handler ─────────────────────────────────────────────────────────
    bot.catch((err) => { logger_js_1.logger.error({ err }, "Bot error"); });
    // ── Launch ────────────────────────────────────────────────────────────────
    await bot.launch({ allowedUpdates: ["message", "callback_query"] });
    logger_js_1.logger.info("Telegram bot started (polling)");
    scheduleWeeklyYtDlpUpdate();
    const shutdown = (signal) => {
        bot.stop(signal);
        void (0, mtproto_sender_js_1.stopMtprotoSender)();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    setInterval(() => {
        void (0, downloader_js_1.cleanupStaleDownloadDirs)().catch((err) => {
            logger_js_1.logger.warn({ err }, "Failed to clean stale download folders");
        });
    }, 60 * 60 * 1000);
    const throttleMapCleanup = setInterval(() => {
        const expiredBefore = Date.now() - UPSERT_TTL * 2;
        for (const [userId, lastUpsert] of recentlyUpserted) {
            if (lastUpsert < expiredBefore)
                recentlyUpserted.delete(userId);
        }
    }, 60 * 60 * 1000);
    throttleMapCleanup.unref();
}
main().catch((err) => {
    logger_js_1.logger.error({ err }, "Fatal startup error");
    void (async () => {
        await (0, mtproto_sender_js_1.stopMtprotoSender)().catch(() => { });
        process.exit(1);
    })();
});
//# sourceMappingURL=index.js.map