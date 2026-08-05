import type { Context } from "telegraf";
import { createReadStream } from "node:fs";
import {
  detectPlatform,
  getVideoInfo,
  downloadMedia,
  cleanupFile,
  formatFileSize,
  formatDuration,
} from "../utils/downloader.js";
import { buildFormatKeyboard } from "../keyboards.js";
import { incrementDownloadCount, logDownload, isPlatformEnabled } from "../db.js";
import { logger } from "../logger.js";

let BOT_USERNAME = "YourBot";
export function setBotUsername(u: string): void { BOT_USERNAME = u; }

const pendingDownloads = new Map<string, {
  url: string;
  title: string;
  platform: string;
  thumbnail: string;
  photoMsgId?: number;
}>();

const PLATFORM_NAMES: Record<string, string> = {
  youtube:   "يوتيوب",
  tiktok:    "تيك توك",
  facebook:  "فيسبوك",
  instagram: "إنستجرام",
  snapchat:  "سناب شات",
  unknown:   "غير معروف",
};

function esc(t: string) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// تنظيف اسم الملف: استبدال الشرطات السفلية بمسافات
function cleanFileName(name: string): string {
  return name.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
}

function buildProgressBar(pct: number): string {
  const f = Math.round(pct / 10);
  return "▓".repeat(f) + "░".repeat(10 - f) + ` ${Math.round(pct)}%`;
}

// ── Core: download + send ──────────────────────────────────────────────────

async function performDownloadAndSend(
  ctx: Context,
  {
    url, title, platform, formatId, chatId, userId,
    editProgress, photoMsgId,
  }: {
    url: string;
    title: string;
    platform: string;
    formatId: string;
    chatId: number;
    userId: number;
    editProgress: (text: string) => Promise<void>;
    photoMsgId?: number;
  }
): Promise<void> {
  try {
    let lastPct = 0;
    const result = await downloadMedia(
      url, formatId, platform as any,
      async (pct) => {
        if (pct - lastPct >= 15 || pct >= 99) {
          lastPct = pct;
          await editProgress(
            `⬇️ <b>جاري التحميل...</b>\n\n🎬 ${esc(title.slice(0, 80))}\n📊 ${buildProgressBar(pct)}`
          );
        }
      }
    );

    await editProgress(`✅ <b>تم التحميل!</b> جاري الإرسال... (${formatFileSize(result.fileSize)})`);

    const fileStream = createReadStream(result.filePath);

    if (formatId === "audio_only") {
      await ctx.replyWithAudio(
        { source: fileStream, filename: cleanFileName(result.fileName) },
        { caption: `@${BOT_USERNAME}`, title: title.slice(0, 64) }
      );
    } else {
      await ctx.replyWithVideo(
        { source: fileStream, filename: cleanFileName(result.fileName) },
        { caption: `@${BOT_USERNAME}`, supports_streaming: true }
      );
    }

    await incrementDownloadCount(userId);
    await logDownload({ userId, url, platform, quality: formatId, status: "success" });

    if (photoMsgId) {
      await ctx.telegram.deleteMessage(chatId, photoMsgId).catch(() => {});
    }
    await cleanupFile(result.filePath);
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

    await editProgress(
      `❌ <b>فشل التحميل</b>\n\n` +
      (isAccessError
        ? "الفيديو خاص أو محذوف أو غير متاح في منطقتك"
        : isNetworkError
          ? "فشل الاتصال، يرجى المحاولة مرة أخرى"
          : esc(msg.slice(0, 300)))
    );
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
      await ctx.telegram.editMessageText(
        chatId, loadMsg.message_id, undefined,
        `📖 <b>جاري تحميل الستوري...</b>\n\n🎬 ${esc(info.title.slice(0, 80))}`,
        { parse_mode: "HTML" }
      ).catch(() => {});

      const editProgress = async (text: string) => {
        await ctx.telegram.editMessageText(chatId, loadMsg.message_id, undefined, text, { parse_mode: "HTML" }).catch(() => {});
      };

      await performDownloadAndSend(ctx, {
        url, title: info.title, platform,
        formatId: "best_video",
        chatId, userId, editProgress,
      });

      await ctx.telegram.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
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
    if (info.thumbnail) {
      try {
        const sent = await ctx.replyWithPhoto(info.thumbnail, { caption, parse_mode: "HTML", reply_markup: keyboard.reply_markup });
        photoMsgId = sent.message_id;
      } catch {
        const sent = await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
        photoMsgId = sent.message_id;
      }
    } else {
      const sent = await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
      photoMsgId = sent.message_id;
    }

    pendingDownloads.set(msgId, { url, title: info.title, platform, thumbnail: info.thumbnail, photoMsgId });
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
  if (!pending) {
    await ctx.answerCbQuery("❌ انتهت صلاحية هذا الطلب، أرسل الرابط مجدداً");
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

  const editProgress = async (text: string) => {
    if (pending.photoMsgId) {
      await ctx.telegram.editMessageCaption(chatId, pending.photoMsgId, undefined, text, { parse_mode: "HTML" }).catch(() => {});
    }
  };

  await editProgress(
    `⬇️ <b>جاري التحميل...</b>\n\n` +
    `🎬 ${esc(pending.title.slice(0, 80))}\n` +
    `📦 الجودة: ${qualityLabel}\n\n` +
    `<i>قد يستغرق بعض الوقت...</i>`
  );

  await performDownloadAndSend(ctx, {
    url: pending.url,
    title: pending.title,
    platform: pending.platform,
    formatId,
    chatId,
    userId,
    editProgress,
    photoMsgId: pending.photoMsgId,
  });
}
