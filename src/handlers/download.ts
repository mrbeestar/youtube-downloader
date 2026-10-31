import type { Context } from "telegraf";
import {
  detectPlatform,
  getVideoInfo,
  downloadMedia,
  cleanupFile,
  formatFileSize,
  formatDuration,
} from "../utils/downloader.js";
import { isMtprotoSenderReady, sendMediaViaMtproto } from "../utils/mtproto-sender.js";
import { buildFormatKeyboard } from "../keyboards.js";
import {
  incrementDownloadCount,
  logDownload,
  isPlatformEnabled,
  scheduleMessageDeletions,
} from "../db.js";
import { logger } from "../logger.js";

let BOT_USERNAME = "YourBot";
export function setBotUsername(u: string): void { BOT_USERNAME = u; }

const pendingDownloads = new Map<string, {
  url: string;
  title: string;
  audioTitle: string;
  performer: string;
  album: string;
  duration: number;
  platform: string;
  thumbnail: string;
  requesterId: number;
  chatId: number;
  createdAt: number;
  photoMsgId?: number;
  photoFileId?: string;
}>();

const PENDING_DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const FILE_EXPIRY_MS = 60 * 60 * 1000;
const FILE_EXPIRY_WARNING =
  "تنبيه : هذا الملف سيتم حذفه بعد ساعة من الان قم باعادة ارسالة الى رسائلك المحفوظة";

interface DownloadStatusState {
  messageId: number;
  photoFileId?: string;
}

interface DownloadStatusUpdater {
  replace(text: string): Promise<void>;
  remove(): Promise<void>;
}

const PLATFORM_NAMES: Record<string, string> = {
  youtube:   "يوتيوب",
  tiktok:    "تيك توك",
  facebook:  "فيسبوك",
  instagram: "إنستجرام",
  snapchat:  "سناب شات",
  x:         "X",
  pinterest: "Pinterest",
  soundcloud:"SoundCloud",
  unknown:   "غير معروف",
};

function esc(t: string) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// تنظيف اسم الملف: استبدال الشرطات السفلية بمسافات
function cleanFileName(name: string): string {
  return name.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
}

function createDownloadStatusUpdater(
  ctx: Context,
  chatId: number,
  state: DownloadStatusState,
): DownloadStatusUpdater {
  return {
    async replace(text: string) {
      await ctx.telegram.deleteMessage(chatId, state.messageId).catch(() => {});
      const message = state.photoFileId
        ? await ctx.telegram.sendPhoto(chatId, state.photoFileId, {
            caption: text,
            parse_mode: "HTML",
          })
        : await ctx.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
      state.messageId = message.message_id;
    },
    async remove() {
      await ctx.telegram.deleteMessage(chatId, state.messageId).catch(() => {});
    },
  };
}

// ── Core: download + send ──────────────────────────────────────────────────

async function performDownloadAndSend(
  ctx: Context,
  {
    url, title, platform, formatId, chatId, userId,
    audioTitle, performer, album, duration, status,
  }: {
    url: string;
    title: string;
    audioTitle?: string;
    performer?: string;
    album?: string;
    duration?: number;
    platform: string;
    formatId: string;
    chatId: number;
    userId: number;
    status: DownloadStatusUpdater;
  }
): Promise<void> {
  let downloadedFilePath: string | undefined;

  try {
    if (!isMtprotoSenderReady()) {
      throw new Error("رفع الوسائط غير مهيأ؛ أضف TELEGRAM_API_ID وTELEGRAM_API_HASH في Secrets");
    }

    const result = await downloadMedia(url, formatId, platform as any);
    downloadedFilePath = result.filePath;

    const sentFileMessageId = await sendMediaViaMtproto({
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

    let warningMessageId: number | undefined;
    try {
      const deleteAt = new Date(Date.now() + FILE_EXPIRY_MS);
      const warning = await ctx.telegram.sendMessage(chatId, FILE_EXPIRY_WARNING);
      warningMessageId = warning.message_id;
      await scheduleMessageDeletions([
        { chatId, messageId: sentFileMessageId, deleteAt },
        { chatId, messageId: warningMessageId, deleteAt },
      ]);
    } catch {
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

    await incrementDownloadCount(userId);
    await logDownload({ userId, url, platform, quality: formatId, status: "success" });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "خطأ غير معروف";
    logger.error({ err, url }, "Download failed");
    await logDownload({ userId, url, platform, quality: formatId, status: "failed", errorMessage: msg.slice(0, 500) });
    const isAccessError =
      msg.includes("403") ||
      msg.includes("404") ||
      msg.includes("Private video") ||
      msg.includes("private video") ||
      msg.includes("This video is not available") ||
      msg.includes("not available in your country") ||
      msg.includes("geo") ||
      msg.includes("age-restricted") ||
      msg.includes("members-only") ||
      msg.includes("This video has been removed");

    const isNetworkError =
      msg.includes("urlopen") ||
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("Connection") ||
      msg.includes("timed out") ||
      msg.includes("Read timed out");

    await status.replace(
      `❌ <b>فشل التحميل</b>\n\n` +
      (isAccessError
        ? "الفيديو خاص أو محذوف أو غير متاح في منطقتك"
        : isNetworkError
          ? "فشل الاتصال، يرجى المحاولة مرة أخرى"
          : esc(msg.slice(0, 300)))
    );
  } finally {
    if (downloadedFilePath) await cleanupFile(downloadedFilePath);
  }
}

// ── handleUrl ─────────────────────────────────────────────────────────────

export async function handleUrl(ctx: Context, url: string): Promise<void> {
  const userId   = ctx.from!.id;
  const chatId   = ctx.chat!.id;
  const platform = detectPlatform(url);

  if (!(await isPlatformEnabled(platform))) {
    await ctx.reply(`❌ <b>التحميل من ${PLATFORM_NAMES[platform]} معطل حالياً</b>`, { parse_mode: "HTML" });
    return;
  }

  const loadMsg = await ctx.reply("⏳ جاري جلب معلومات الفيديو...", { parse_mode: "HTML" });

  try {
    const info = await getVideoInfo(url);

    // ── ستوري: تحميل مباشر بدون اختيار جودة ─────────────────────────────
    if (info.isStory) {
      const status = createDownloadStatusUpdater(ctx, chatId, {
        messageId: loadMsg.message_id,
      });
      await status.replace(
        `⬇️📤 <b>جاري التنزيل والإرسال...</b>\n\n🎬 ${esc(info.title.slice(0, 80))}`
      );

      await performDownloadAndSend(ctx, {
        url, title: info.title, platform,
        formatId: "best_video",
        chatId, userId, status,
      });

      return;
    }

    // ── فيديو عادي: اختيار الجودة ────────────────────────────────────────
    const msgId = `${userId}_${loadMsg.message_id}`;
    await ctx.telegram.deleteMessage(chatId, loadMsg.message_id).catch(() => {});

    const caption =
      `🎬 <b>${esc(info.title.slice(0, 200))}</b>\n\n` +
      `📌 ${PLATFORM_NAMES[platform]}  •  ⏱ ${formatDuration(info.duration)}` +
      `\n\n<i>اختر الجودة المطلوبة:</i>`;

    const keyboard = buildFormatKeyboard(info, msgId);

    let photoMsgId: number | undefined;
    let photoFileId: string | undefined;
    if (info.thumbnail) {
      try {
        const sent = await ctx.replyWithPhoto(info.thumbnail, { caption, parse_mode: "HTML", reply_markup: keyboard.reply_markup });
        photoMsgId = sent.message_id;
        photoFileId = sent.photo.at(-1)?.file_id;
      } catch {
        const sent = await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
        photoMsgId = sent.message_id;
      }
    } else {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : "خطأ غير معروف";
    logger.error({ err, url }, "Failed to get video info");
    await ctx.telegram.editMessageText(
      chatId, loadMsg.message_id, undefined,
      `❌ <b>فشل جلب معلومات الفيديو</b>\n\n` +
      (msg.includes("Unable to extract") || msg.includes("Unsupported URL")
        ? "تأكد من صحة الرابط أو أن الفيديو غير خاص"
        : esc(msg.slice(0, 300))),
      { parse_mode: "HTML" }
    ).catch(() => {});
  }
}

// ── handleDownloadCallback ────────────────────────────────────────────────

export async function handleDownloadCallback(
  ctx: Context,
  msgId: string,
  formatId: string
): Promise<void> {
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

  const userId       = ctx.from!.id;
  const chatId       = ctx.chat!.id;
  const qualityLabel =
    formatId === "audio_only" ? "MP3 صوت فقط" :
    formatId === "best_video" ? "أفضل جودة"   :
    formatId.replace("video_", "") + "p";

  const status = createDownloadStatusUpdater(ctx, chatId, {
    messageId: pending.photoMsgId!,
    photoFileId: pending.photoFileId,
  });
  await status.replace(
    `⬇️📤 <b>جاري التنزيل والإرسال...</b>\n\n` +
    `🎬 ${esc(pending.title.slice(0, 80))}\n` +
    `📦 الجودة: ${qualityLabel}\n\n` +
    `<i>قد يستغرق بعض الوقت...</i>`
  );

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
