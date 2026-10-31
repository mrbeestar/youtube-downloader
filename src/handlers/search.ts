import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { handleUrl } from "./download.js";
import { YT_DLP_PATH } from "../utils/downloader.js";
import { logger } from "../logger.js";
import { saveVideoId, getVideoUrl, cleanupOldVideoIds } from "../db.js";

const execFileAsync = promisify(execFile);

export interface SearchResult {
  id: string;
  title: string;
  duration: number;
  viewCount: number;
  uploader: string;
  url: string;
}

interface SearchSession {
  query: string;
  results: SearchResult[];
  page: number;
  fetchedCount: number;
  hasMore: boolean;
}

const PAGE_SIZE   = 20;
const FETCH_CHUNK = 20;

const sessions = new Map<number, SearchSession>();

// كاش في الذاكرة للجلسة الحالية (سريع)
// عند miss يرجع لقاعدة البيانات (دائم لمدة 30 يوم)
const videoRegistry = new Map<string, string>();

function sanitizeId(videoId: string): string {
  return videoId.replace(/-/g, "_");
}

export async function getUrlByCommandId(sanitizedId: string): Promise<string | undefined> {
  // أولاً: ابحث في الكاش السريع
  const cached = videoRegistry.get(sanitizedId);
  if (cached) return cached;
  // ثانياً: ارجع لقاعدة البيانات
  const fromDb = await getVideoUrl(sanitizedId);
  if (fromDb) videoRegistry.set(sanitizedId, fromDb);
  return fromDb;
}

// تنظيف يومي: يعمل عند التشغيل ثم كل 24 ساعة، ولا يمنع إيقاف الخدمة.
void cleanupOldVideoIds().catch(() => {});
const videoRegistryCleanupTimer = setInterval(() => {
  cleanupOldVideoIds().catch(() => {});
}, 24 * 60 * 60 * 1000);
videoRegistryCleanupTimer.unref();

// ── Fetch helpers ─────────────────────────────────────────────────────────

async function fetchChunk(query: string, start: number, end: number): Promise<SearchResult[]> {
  const safeQuery = query.trim().slice(0, 200);
  const poolSize  = end + 20;
  const args = [
    "--no-warnings",
    "--flat-playlist",
    "--dump-json",
    "--no-check-certificates",
    "--playlist-start", `${start}`,
    "--playlist-end", `${end}`,
    "--extractor-args", "youtube:skip=dash,hls",
    `ytsearch${poolSize}:${safeQuery}`,
  ];

  const { stdout } = await execFileAsync(YT_DLP_PATH, args, {
    timeout: 40_000,
    maxBuffer: 20 * 1024 * 1024,
  });

  const results: SearchResult[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const info    = JSON.parse(line);
      const videoId = info.id || "";
      if (!videoId || videoId.length < 5) continue;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const sid = sanitizeId(videoId);
      videoRegistry.set(sid, url);
      saveVideoId(sid, url).catch(() => {}); // حفظ في قاعدة البيانات بشكل غير متزامن
      results.push({
        id: videoId,
        title: (info.title || "بدون عنوان").slice(0, 80),
        duration: info.duration || 0,
        viewCount: info.view_count || 0,
        uploader: (info.uploader || info.channel || "غير معروف").slice(0, 40),
        url,
      });
    } catch { /* skip */ }
  }
  return results;
}

// ── Format helpers ────────────────────────────────────────────────────────

function fmtViews(n: number): string {
  if (!n)                 return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function fmtDur(sec: number): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildMessage(session: SearchSession): string {
  const { query, results, page } = session;
  const start    = page * PAGE_SIZE;
  const slice    = results.slice(start, start + PAGE_SIZE);
  const pageNum  = page + 1;

  let text =
    `🔍 <b>نتائج البحث:</b> <i>${esc(query)}</i>\n` +
    `📄 الصفحة ${pageNum}` +
    (session.hasMore || start + PAGE_SIZE < results.length ? "" : ` (${results.length} نتيجة)`) +
    `\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (let i = 0; i < slice.length; i++) {
    const r = slice[i]!;
    const globalNum = start + i + 1;
    const dur = fmtDur(r.duration);
    text +=
      `${globalNum}. <b>${esc(r.title)}</b>\n` +
      `👁 ${fmtViews(r.viewCount)} مشاهدة${dur ? `  ⏱ ${dur}` : ""}\n` +
      `📺 ${esc(r.uploader)}\n` +
      `/k_${sanitizeId(r.id)}\n\n`;
  }
  return text.trimEnd();
}

function buildKeyboard(session: SearchSession) {
  const { page, results, hasMore } = session;
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const hasPrev    = page > 0;
  const hasNext    = page < totalPages - 1 || hasMore;

  const nav: ReturnType<typeof Markup.button.callback>[] = [];
  if (hasPrev) nav.push(Markup.button.callback("◀️ السابق", `srch:p:${page - 1}`));
  if (hasNext) nav.push(Markup.button.callback("▶️ التالي",  `srch:p:${page + 1}`));

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback("❌ إغلاق", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

// ── Public API ────────────────────────────────────────────────────────────

export function getSearchResult(userId: number, globalNum: number): SearchResult | undefined {
  return sessions.get(userId)?.results[globalNum - 1];
}

export async function handleSearch(ctx: Context, query: string): Promise<void> {
  const userId    = ctx.from!.id;
  const statusMsg = await ctx.reply(`🔍 <b>جاري البحث عن:</b> ${esc(query)}...`, { parse_mode: "HTML" });

  try {
    const chunk = await fetchChunk(query, 1, FETCH_CHUNK);

    if (chunk.length === 0) {
      await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined,
        "❌ لم يتم العثور على نتائج، جرب كلمات أخرى", { parse_mode: "HTML" });
      return;
    }

    const session: SearchSession = {
      query, results: chunk, page: 0,
      fetchedCount: chunk.length,
      hasMore: chunk.length === FETCH_CHUNK,
    };
    sessions.set(userId, session);

    await ctx.telegram.editMessageText(
      ctx.chat!.id, statusMsg.message_id, undefined,
      buildMessage(session),
      { parse_mode: "HTML", reply_markup: buildKeyboard(session).reply_markup }
    );
  } catch (err) {
    logger.error({ err, query }, "YouTube search failed");
    await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined,
      "❌ فشل البحث، يرجى المحاولة لاحقاً", { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function handleSearchPage(ctx: Context, page: number): Promise<void> {
  const userId  = ctx.from!.id;
  const session = sessions.get(userId);
  if (!session) {
    await ctx.answerCbQuery("❌ انتهت الجلسة، ابحث مجدداً");
    return;
  }

  const needed = (page + 1) * PAGE_SIZE;
  if (needed > session.results.length && session.hasMore) {
    await ctx.answerCbQuery("⏳ جاري تحميل المزيد من النتائج...");
    try {
      const nextStart = session.fetchedCount + 1;
      const nextEnd   = session.fetchedCount + FETCH_CHUNK;
      const chunk = await fetchChunk(session.query, nextStart, nextEnd);
      session.results.push(...chunk);
      session.fetchedCount += chunk.length;
      session.hasMore = chunk.length === FETCH_CHUNK;
    } catch {
      await ctx.answerCbQuery("❌ فشل تحميل المزيد");
      return;
    }
  } else {
    await ctx.answerCbQuery();
  }

  session.page = page;
  await ctx.editMessageText(buildMessage(session), {
    parse_mode: "HTML",
    reply_markup: buildKeyboard(session).reply_markup,
  }).catch(() => {});
}

export async function handleYtCommand(ctx: Context, globalNum: number): Promise<void> {
  const result = getSearchResult(ctx.from!.id, globalNum);
  if (!result) {
    await ctx.reply("❌ لم يُعثر على هذا الفيديو.\nقم بإجراء بحث جديد أولاً", { parse_mode: "HTML" });
    return;
  }
  await handleUrl(ctx, result.url);
}

/**
 * تنفيذ أمر /k_<sanitizedId> — يبحث في الكاش ثم قاعدة البيانات
 */
export async function handleKCommand(ctx: Context, sanitizedId: string): Promise<void> {
  const url = await getUrlByCommandId(sanitizedId);
  if (!url) {
    await ctx.reply(
      "❌ <b>لم يُعثر على هذا الفيديو</b>\n\nقد تكون نتائج البحث قديمة جداً (+30 يوم).\nأجرِ بحثاً جديداً.",
      { parse_mode: "HTML" }
    );
    return;
  }
  await handleUrl(ctx, url);
}
