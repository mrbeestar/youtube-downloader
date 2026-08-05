import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { logger } from "../logger.js";

const execAsync = promisify(exec);

export const YT_DLP_PATH  = process.env["YT_DLP_PATH"]  || "./bin/yt-dlp";
export const DOWNLOAD_DIR = process.env["DOWNLOAD_DIR"] || "/tmp/bot_downloads";

if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ── سيمافور: أقصى 8 تحميلات متزامنة في نفس الوقت ─────────────────────────
const MAX_CONCURRENT_DOWNLOADS = 8;
let activeDownloads = 0;
const downloadQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads++;
    return Promise.resolve();
  }
  return new Promise(resolve => downloadQueue.push(resolve));
}

function releaseSlot(): void {
  const next = downloadQueue.shift();
  if (next) {
    next(); // ينقل المنتظر للتنفيذ مباشرة
  } else {
    activeDownloads--;
  }
}

export type Platform = "youtube" | "tiktok" | "facebook" | "instagram" | "snapchat" | "unknown";
export type MediaType = "video" | "audio" | "story";

export interface VideoInfo {
  title: string;
  duration: number;
  thumbnail: string;
  platform: Platform;
  formats: FormatOption[];
  isStory: boolean;
  webpage_url: string;
}

export interface FormatOption {
  id: string;
  label: string;
  quality: string;
  ext: string;
  filesize?: number;
  type: "video" | "audio";
}

export function detectPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  if (lower.includes("tiktok.com"))                                 return "tiktok";
  if (lower.includes("facebook.com") || lower.includes("fb.com") || lower.includes("fb.watch")) return "facebook";
  if (lower.includes("instagram.com"))                              return "instagram";
  if (lower.includes("snapchat.com") || lower.includes("snap.com")) return "snapchat";
  return "unknown";
}

export function isStoryUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("/stories/") ||
    lower.includes("/story/")   ||
    lower.includes("story.snapchat") ||
    lower.includes("/reel/")    ||
    lower.includes("/reels/")
  );
}

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const platform = detectPlatform(url);
  const isStory  = isStoryUrl(url);

  const args = ["--no-warnings", "--dump-json", "--no-playlist"];

  if (platform === "tiktok") {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
  }

  args.push(url);

  const cmd = `${YT_DLP_PATH} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  const { stdout } = await execAsync(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(stdout);

  const formats: FormatOption[] = [];

  const videoQualities = [
    { label: "1080p HD",   vcodec: "1080" },
    { label: "720p HD",    vcodec: "720"  },
    { label: "480p",       vcodec: "480"  },
    { label: "360p",       vcodec: "360"  },
    { label: "أفضل جودة", vcodec: "best" },
  ];

  for (const q of videoQualities) {
    const id = q.vcodec === "best" ? "best_video" : `video_${q.vcodec}`;
    formats.push({ id, label: `🎬 ${q.label}`, quality: q.vcodec, ext: "mp4", type: "video" });
  }

  formats.push({ id: "audio_only", label: "🎵 صوت فقط MP3", quality: "best", ext: "mp3", type: "audio" });

  return {
    title: info.title || "فيديو",
    duration: info.duration || 0,
    thumbnail: info.thumbnail || "",
    platform,
    formats,
    isStory,
    webpage_url: info.webpage_url || url,
  };
}

export interface DownloadResult {
  filePath: string;
  fileName: string;
  fileSize: number;
  ext: string;
}

export async function downloadMedia(
  url: string,
  formatId: string,
  platform: Platform,
  onProgress?: (percent: number) => void
): Promise<DownloadResult> {
  // الانتظار في طابور السيمافور قبل البدء
  await acquireSlot();

  const timestamp      = Date.now();
  const outputDir      = join(DOWNLOAD_DIR, `${timestamp}`);
  mkdirSync(outputDir, { recursive: true });

  const outputTemplate = join(outputDir, "%(title)s.%(ext)s");

  const args: string[] = [
    "--no-warnings",
    "--no-playlist",
    "--no-part",
    "--merge-output-format", "mp4",
  ];

  if (formatId === "audio_only") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (formatId === "best_video") {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best");
  } else {
    const height = formatId.replace("video_", "");
    args.push(
      "-f",
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`
    );
  }

  if (platform === "tiktok") args.push("--embed-metadata");
  if (platform === "instagram" || platform === "snapchat") {
    args.push("--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }

  args.push("-o", outputTemplate, url);

  try {
    return await new Promise<DownloadResult>((resolve, reject) => {
      const proc = spawn(YT_DLP_PATH, args, { timeout: 600000 });
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        const line  = chunk.toString();
        const match = line.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (match && onProgress) onProgress(parseFloat(match[1]));
      });

      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", async (code) => {
        if (code !== 0) {
          await rm(outputDir, { recursive: true, force: true }).catch(() => {});
          reject(new Error(`فشل التحميل: ${stderr.slice(-200)}`));
          return;
        }

        const { readdir, stat } = await import("node:fs/promises");
        const files = await readdir(outputDir);
        if (files.length === 0) {
          await rm(outputDir, { recursive: true, force: true }).catch(() => {});
          reject(new Error("لم يتم العثور على الملف المحمّل"));
          return;
        }

        const filePath = join(outputDir, files[0]!);
        const fileStat = await stat(filePath);
        const ext      = files[0]!.split(".").pop() || "mp4";

        resolve({ filePath, fileName: files[0]!, fileSize: fileStat.size, ext });
      });

      proc.on("error", (err) => {
        reject(new Error(`خطأ في التشغيل: ${err.message}`));
      });
    });
  } finally {
    releaseSlot(); // يُحرَّر الـ slot دائماً بغض النظر عن النتيجة
  }
}

export async function cleanupFile(filePath: string): Promise<void> {
  const dir = filePath.split("/").slice(0, -1).join("/");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024)              return `${bytes} B`;
  if (bytes < 1024 * 1024)       return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "غير معروف";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
