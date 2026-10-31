"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setBotUsername = setBotUsername;
exports.handleUrl = handleUrl;
exports.handleDownloadCallback = handleDownloadCallback;
const downloader_js_1 = require("../utils/downloader.js");
const mtproto_sender_js_1 = require("../utils/mtproto-sender.js");
const keyboards_js_1 = require("../keyboards.js");
const db_js_1 = require("../db.js");
const logger_js_1 = require("../logger.js");
let BOT_USERNAME = "YourBot";
function setBotUsername(u) { BOT_USERNAME = u; }
const pendingDownloads = new Map();
const PENDING_DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const FILE_EXPIRY_MS = 60 * 60 * 1000;
const FILE_EXPIRY_WARNING = "تنبيه : هذا الملف سيتم حذفه بعد ساعة من الان قم باعادة ارسالة الى رسائلك المحفوظة";
const PLATFORM_NAMES = {
    youtube: "يوتيوب",
    tiktok: "تيك توك",
    facebook: "فيسبوك",
    instagram: "إنستجرام",
    snapchat: "سناب شات",
    x: "X",
    pinterest: "Pinterest",
    soundcloud: "SoundCloud",
    unknown: "غير معروف",
};
function esc(t) {
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// تنظيف اسم الملف: استبدال الشرطات السفلية بمسافات
function cleanFileName(name) {
    return name.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
}
function createDownloadStatusUpdater(ctx, chatId, state) {
    return {
        async replace(text) {
            await ctx.telegram.deleteMessage(chatId, state.messageId).catch(() => { });
            const message = state.photoFileId
                ? await ctx.telegram.sendPhoto(chatId, state.photoFileId, {
                    caption: text,
                    parse_mode: "HTML",
                })
                : await ctx.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
            state.messageId = message.message_id;
        },
        async remove() {
            await ctx.telegram.deleteMessage(chatId, state.messageId).catch(() => { });
        },
    };
}
// ── Core: download + send ──────────────────────────────────────────────────
async function performDownloadAndSend(ctx, { url, title, platform, formatId, chatId, userId, audioTitle, performer, album, duration, status, }) {
    let downloadedFilePath;
    try {
        if (!(0, mtproto_sender_js_1.isMtprotoSenderReady)()) {
            throw new Error("رفع الوسائط غير مهيأ؛ أضف TELEGRAM_API_ID وTELEGRAM_API_HASH في Secrets");
        }
        const result = await (0, downloader_js_1.downloadMedia)(url, formatId, platform);
        downloadedFilePath = result.filePath;
        const sentFileMessageId = await (0, mtproto_sender_js_1.sendMediaViaMtproto)({
            chatId,
            filePath: result.filePath,
            mediaType: formatId === "audio_only" ? "audio" : "video",
            thumbnailPath: formatId === "audio_only" ? undefined : result.thumbnailPath,
            caption: formatId === "audio_only"
                ? `${album ? `💿 الألبوم: ${album.slice(0, 256)}\n` : ""}@${BOT_USERNAME}`
                : `@${BOT_USERNAME}`,
            title: (formatId === "audio_only" ? audioTitle || title : title).slice(0, 64),
            performer: formatId === "audio_only" ? performer : undefined,
            duration: formatId === "audio_only" ? duration : undefined,
        });
        let warningMessageId;
        try {
            const deleteAt = new Date(Date.now() + FILE_EXPIRY_MS);
            const warning = await ctx.telegram.sendMessage(chatId, FILE_EXPIRY_WARNING);
            warningMessageId = warning.message_id;
            await (0, db_js_1.scheduleMessageDeletions)([
                { chatId, messageId: sentFileMessageId, deleteAt },
                { chatId, messageId: warningMessageId, deleteAt },
            ]);
        }
        catch {
            const rollback = [
                ctx.telegram.deleteMessage(chatId, sentFileMessageId).catch(() => false),
            ];
            if (warningMessageId !== undefined) {
                rollback.push(ctx.telegram.deleteMessage(chatId, warningMessageId).catch(() => false));
            }
            await Promise.all(rollback);
            throw new Error("تعذر جدولة الحذف التلقائي؛ حاول إرسال الملف مرة أخرى بعد قليل.");
        }
        await status.remove();
        await (0, db_js_1.incrementDownloadCount)(userId);
        await (0, db_js_1.logDownload)({ userId, url, platform, quality: formatId, status: "success" });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "خطأ غير معروف";
        logger_js_1.logger.error({ err, url }, "Download failed");
        await (0, db_js_1.logDownload)({ userId, url, platform, quality: formatId, status: "failed", errorMessage: msg.slice(0, 500) });
        const isAccessError = msg.includes("403") ||
            msg.includes("404") ||
            msg.includes("Private video") ||
            msg.includes("private video") ||
            msg.includes("This video is not available") ||
            msg.includes("not available in your country") ||
            msg.includes("geo") ||
            msg.includes("age-restricted") ||
            msg.includes("members-only") ||
            msg.includes("This video has been removed");
        const isNetworkError = msg.includes("urlopen") ||
            msg.includes("429") ||
            msg.includes("500") ||
            msg.includes("502") ||
            msg.includes("503") ||
            msg.includes("Connection") ||
            msg.includes("timed out") ||
            msg.includes("Read timed out");
        await status.replace(`❌ <b>فشل التحميل</b>\n\n` +
            (isAccessError
                ? "الفيديو خاص أو محذوف أو غير متاح في منطقتك"
                : isNetworkError
                    ? "فشل الاتصال، يرجى المحاولة مرة أخرى"
                    : esc(msg.slice(0, 300))));
    }
    finally {
        if (downloadedFilePath)
            await (0, downloader_js_1.cleanupFile)(downloadedFilePath);
    }
}
// ── handleUrl ─────────────────────────────────────────────────────────────
async function handleUrl(ctx, url) {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const platform = (0, downloader_js_1.detectPlatform)(url);
    if (!(await (0, db_js_1.isPlatformEnabled)(platform))) {
        await ctx.reply(`❌ <b>التحميل من ${PLATFORM_NAMES[platform]} معطل حالياً</b>`, { parse_mode: "HTML" });
        return;
    }
    const loadMsg = await ctx.reply("⏳ جاري جلب معلومات الفيديو...", { parse_mode: "HTML" });
    try {
        const info = await (0, downloader_js_1.getVideoInfo)(url);
        // ── ستوري: تحميل مباشر بدون اختيار جودة ─────────────────────────────
        if (info.isStory) {
            const status = createDownloadStatusUpdater(ctx, chatId, {
                messageId: loadMsg.message_id,
            });
            await status.replace(`⬇️📤 <b>جاري التنزيل والإرسال...</b>\n\n🎬 ${esc(info.title.slice(0, 80))}`);
            await performDownloadAndSend(ctx, {
                url, title: info.title, platform,
                formatId: "best_video",
                chatId, userId, status,
            });
            return;
        }
        // ── فيديو عادي: اختيار الجودة ────────────────────────────────────────
        const msgId = `${userId}_${loadMsg.message_id}`;
        await ctx.telegram.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
        const caption = `🎬 <b>${esc(info.title.slice(0, 200))}</b>\n\n` +
            `📌 ${PLATFORM_NAMES[platform]}  •  ⏱ ${(0, downloader_js_1.formatDuration)(info.duration)}` +
            `\n\n<i>اختر الجودة المطلوبة:</i>`;
        const keyboard = (0, keyboards_js_1.buildFormatKeyboard)(info, msgId);
        let photoMsgId;
        let photoFileId;
        if (info.thumbnail) {
            try {
                const sent = await ctx.replyWithPhoto(info.thumbnail, { caption, parse_mode: "HTML", reply_markup: keyboard.reply_markup });
                photoMsgId = sent.message_id;
                photoFileId = sent.photo.at(-1)?.file_id;
            }
            catch {
                const sent = await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
                photoMsgId = sent.message_id;
            }
        }
        else {
            const sent = await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
            photoMsgId = sent.message_id;
        }
        const createdAt = Date.now();
        for (const [pendingId, pending] of pendingDownloads) {
            if (createdAt - pending.createdAt > PENDING_DOWNLOAD_TTL_MS) {
                pendingDownloads.delete(pendingId);
            }
        }
        pendingDownloads.set(msgId, {
            url,
            title: info.title,
            audioTitle: info.audioTitle,
            performer: info.performer,
            album: info.album,
            duration: info.duration,
            platform,
            thumbnail: info.thumbnail,
            requesterId: userId,
            chatId,
            createdAt,
            photoMsgId,
            photoFileId,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "خطأ غير معروف";
        logger_js_1.logger.error({ err, url }, "Failed to get video info");
        await ctx.telegram.editMessageText(chatId, loadMsg.message_id, undefined, `❌ <b>فشل جلب معلومات الفيديو</b>\n\n` +
            (msg.includes("Unable to extract") || msg.includes("Unsupported URL")
                ? "تأكد من صحة الرابط أو أن الفيديو غير خاص"
                : esc(msg.slice(0, 300))), { parse_mode: "HTML" }).catch(() => { });
    }
}
// ── handleDownloadCallback ────────────────────────────────────────────────
async function handleDownloadCallback(ctx, msgId, formatId) {
    const pending = pendingDownloads.get(msgId);
    if (!pending || Date.now() - pending.createdAt > PENDING_DOWNLOAD_TTL_MS) {
        pendingDownloads.delete(msgId);
        await ctx.answerCbQuery("❌ انتهت صلاحية هذا الطلب، أرسل الرابط مجدداً");
        return;
    }
    if (ctx.from?.id !== pending.requesterId || ctx.chat?.id !== pending.chatId) {
        await ctx.answerCbQuery("هذا الطلب مخصص للشخص الذي أرسله");
        return;
    }
    await ctx.answerCbQuery("⏳ جاري التحميل...");
    pendingDownloads.delete(msgId);
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const qualityLabel = formatId === "audio_only" ? "MP3 صوت فقط" :
        formatId === "best_video" ? "أفضل جودة" :
            formatId.replace("video_", "") + "p";
    const status = createDownloadStatusUpdater(ctx, chatId, {
        messageId: pending.photoMsgId,
        photoFileId: pending.photoFileId,
    });
    await status.replace(`⬇️📤 <b>جاري التنزيل والإرسال...</b>\n\n` +
        `🎬 ${esc(pending.title.slice(0, 80))}\n` +
        `📦 الجودة: ${qualityLabel}\n\n` +
        `<i>قد يستغرق بعض الوقت...</i>`);
    await performDownloadAndSend(ctx, {
        url: pending.url,
        title: pending.title,
        audioTitle: pending.audioTitle,
        performer: pending.performer,
        album: pending.album,
        duration: pending.duration,
        platform: pending.platform,
        formatId,
        chatId,
        userId,
        status,
    });
}
//# sourceMappingURL=download.js.map