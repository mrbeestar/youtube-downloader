import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

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

export type Platform =
  | "youtube"
  | "tiktok"
  | "facebook"
  | "instagram"
  | "snapchat"
  | "x"
  | "pinterest"
  | "soundcloud"
  | "unknown";
export type MediaType = "video" | "audio" | "story";

export interface VideoInfo {
  title: string;
  audioTitle: string;
  performer: string;
  album: string;
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
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "unknown";
  }

  const matches = (domains: string[]) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

  if (matches(["youtube.com", "youtu.be"])) return "youtube";
  if (matches(["tiktok.com"])) return "tiktok";
  if (matches(["facebook.com", "fb.com", "fb.watch"])) return "facebook";
  if (matches(["instagram.com"])) return "instagram";
  if (matches(["snapchat.com", "snap.com"])) return "snapchat";
  if (matches(["x.com", "twitter.com"])) return "x";
  if (matches(["pinterest.com", "pin.it"])) return "pinterest";
  if (matches(["soundcloud.com"])) return "soundcloud";
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

  const { stdout } = await execFileAsync(YT_DLP_PATH, args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
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
    audioTitle: info.track || info.title || "مقطع صوتي",
    performer: info.artist || info.album_artist || info.uploader || info.channel || "",
    album: info.album || "",
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
  thumbnailPath?: string;
}

export async function downloadMedia(
  url: string,
  formatId: string,
  platform: Platform,
  onProgress?: (percent: number) => void
): Promise<DownloadResult> {
  await acquireSlot();

  try {
    const outputDir = await mkdtemp(join(DOWNLOAD_DIR, "download-"));
    const outputTemplate = join(outputDir, "%(title)s.%(ext)s");
    const args: string[] = [
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      "--merge-output-format", "mp4",
    ];

    if (formatId === "audio_only") {
      args.push(
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--embed-metadata",
        "--embed-thumbnail",
        "--convert-thumbnails", "jpg",
      );
    } else if (formatId === "best_video") {
      args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
      args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best");
    } else {
      args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
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

    return await new Promise<DownloadResult>((resolve, reject) => {
      const proc = spawn(YT_DLP_PATH, args, { timeout: 600000 });
      let stderr = "";
      let settled = false;

      const fail = async (error: Error) => {
        if (settled) return;
        settled = true;
        await rm(outputDir, { recursive: true, force: true }).catch(() => {});
        reject(error);
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        const line  = chunk.toString();
        const match = line.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (match && onProgress) onProgress(parseFloat(match[1]));
      });

      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.once("close", async (code) => {
        if (settled) return;
        if (code !== 0) {
          await fail(new Error(`فشل التحميل: ${stderr.slice(-200)}`));
          return;
        }

        try {
          const files = await readdir(outputDir);
          const allowedExtensions = formatId === "audio_only"
            ? new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"])
            : new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"]);
          const candidates = await Promise.all(files.map(async (name) => {
            const path = join(outputDir, name);
            const fileStat = await stat(path).catch(() => undefined);
            const extension = extname(name).toLowerCase();
            return fileStat?.isFile() && fileStat.size > 0 && allowedExtensions.has(extension)
              ? { name, path, size: fileStat.size, extension }
              : undefined;
          }));
          const mediaFiles = candidates
            .filter((file): file is NonNullable<typeof file> => Boolean(file))
            .sort((a, b) => {
              if (formatId === "audio_only") {
                return (a.extension === ".mp3" ? 0 : 1) - (b.extension === ".mp3" ? 0 : 1);
              }
              return (a.extension === ".mp4" ? 0 : 1) - (b.extension === ".mp4" ? 0 : 1);
            });
          const media = mediaFiles[0];
          if (!media) {
            await fail(new Error("المسار الناتج ليس ملف وسائط"));
            return;
          }

          let thumbnailPath: string | undefined;
          if (formatId !== "audio_only") {
            const thumbnailNames = files
              .filter((name) => [".jpg", ".jpeg", ".png", ".webp"].includes(extname(name).toLowerCase()))
              .sort((a, b) => {
                const extA = extname(a).toLowerCase();
                const extB = extname(b).toLowerCase();
                return (extA === ".jpg" ? 0 : 1) - (extB === ".jpg" ? 0 : 1);
              });
            for (const name of thumbnailNames) {
              const path = join(outputDir, name);
              const info = await stat(path).catch(() => undefined);
              if (info?.isFile() && info.size > 0) {
                thumbnailPath = path;
                break;
              }
            }
          }

          settled = true;
          resolve({
            filePath: media.path,
            fileName: media.name,
            fileSize: media.size,
            ext: media.extension.slice(1),
            thumbnailPath,
          });
        } catch (err) {
          await fail(err instanceof Error ? err : new Error("تعذر قراءة الملف المحمّل"));
        }
      });

      proc.once("error", (err) => {
        void fail(new Error(`خطأ في التشغيل: ${err.message}`));
      });
    });
  } finally {
    releaseSlot();
  }
}

export async function cleanupFile(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true }).catch(() => {});
}

export async function cleanupStaleDownloadDirs(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const { readdir, stat } = await import("node:fs/promises");
  const now = Date.now();
  const entries = await readdir(DOWNLOAD_DIR, { withFileTypes: true }).catch(() => []);

  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const path = join(DOWNLOAD_DIR, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
    }));
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
