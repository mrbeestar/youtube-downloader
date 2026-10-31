"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOWNLOAD_DIR = exports.YT_DLP_PATH = void 0;
exports.detectPlatform = detectPlatform;
exports.isStoryUrl = isStoryUrl;
exports.getVideoInfo = getVideoInfo;
exports.downloadMedia = downloadMedia;
exports.cleanupFile = cleanupFile;
exports.cleanupStaleDownloadDirs = cleanupStaleDownloadDirs;
exports.formatFileSize = formatFileSize;
exports.formatDuration = formatDuration;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const promises_1 = require("node:fs/promises");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
exports.YT_DLP_PATH = process.env["YT_DLP_PATH"] || "./bin/yt-dlp";
exports.DOWNLOAD_DIR = process.env["DOWNLOAD_DIR"] || "/tmp/bot_downloads";
if (!(0, node_fs_1.existsSync)(exports.DOWNLOAD_DIR)) {
    (0, node_fs_1.mkdirSync)(exports.DOWNLOAD_DIR, { recursive: true });
}
// ── سيمافور: أقصى 8 تحميلات متزامنة في نفس الوقت ─────────────────────────
const MAX_CONCURRENT_DOWNLOADS = 8;
let activeDownloads = 0;
const downloadQueue = [];
function acquireSlot() {
    if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
        activeDownloads++;
        return Promise.resolve();
    }
    return new Promise(resolve => downloadQueue.push(resolve));
}
function releaseSlot() {
    const next = downloadQueue.shift();
    if (next) {
        next(); // ينقل المنتظر للتنفيذ مباشرة
    }
    else {
        activeDownloads--;
    }
}
function detectPlatform(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    }
    catch {
        return "unknown";
    }
    const matches = (domains) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (matches(["youtube.com", "youtu.be"]))
        return "youtube";
    if (matches(["tiktok.com"]))
        return "tiktok";
    if (matches(["facebook.com", "fb.com", "fb.watch"]))
        return "facebook";
    if (matches(["instagram.com"]))
        return "instagram";
    if (matches(["snapchat.com", "snap.com"]))
        return "snapchat";
    if (matches(["x.com", "twitter.com"]))
        return "x";
    if (matches(["pinterest.com", "pin.it"]))
        return "pinterest";
    if (matches(["soundcloud.com"]))
        return "soundcloud";
    return "unknown";
}
function isStoryUrl(url) {
    const lower = url.toLowerCase();
    return (lower.includes("/stories/") ||
        lower.includes("/story/") ||
        lower.includes("story.snapchat") ||
        lower.includes("/reel/") ||
        lower.includes("/reels/"));
}
async function getVideoInfo(url) {
    const platform = detectPlatform(url);
    const isStory = isStoryUrl(url);
    const args = ["--no-warnings", "--dump-json", "--no-playlist"];
    if (platform === "tiktok") {
        args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
    }
    args.push(url);
    const { stdout } = await execFileAsync(exports.YT_DLP_PATH, args, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    const info = JSON.parse(stdout);
    const formats = [];
    const videoQualities = [
        { label: "1080p HD", vcodec: "1080" },
        { label: "720p HD", vcodec: "720" },
        { label: "480p", vcodec: "480" },
        { label: "360p", vcodec: "360" },
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
async function downloadMedia(url, formatId, platform, onProgress) {
    await acquireSlot();
    try {
        const outputDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)(exports.DOWNLOAD_DIR, "download-"));
        const outputTemplate = (0, node_path_1.join)(outputDir, "%(title)s.%(ext)s");
        const args = [
            "--no-warnings",
            "--no-playlist",
            "--no-part",
            "--merge-output-format", "mp4",
        ];
        if (formatId === "audio_only") {
            args.push("-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg");
        }
        else if (formatId === "best_video") {
            args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
            args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best");
        }
        else {
            args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
            const height = formatId.replace("video_", "");
            args.push("-f", `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`);
        }
        if (platform === "tiktok")
            args.push("--embed-metadata");
        if (platform === "instagram" || platform === "snapchat") {
            args.push("--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        }
        args.push("-o", outputTemplate, url);
        return await new Promise((resolve, reject) => {
            const proc = (0, node_child_process_1.spawn)(exports.YT_DLP_PATH, args, { timeout: 600000 });
            let stderr = "";
            let settled = false;
            const fail = async (error) => {
                if (settled)
                    return;
                settled = true;
                await (0, promises_1.rm)(outputDir, { recursive: true, force: true }).catch(() => { });
                reject(error);
            };
            proc.stdout.on("data", (chunk) => {
                const line = chunk.toString();
                const match = line.match(/\[download\]\s+(\d+\.?\d*)%/);
                if (match && onProgress)
                    onProgress(parseFloat(match[1]));
            });
            proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
            proc.once("close", async (code) => {
                if (settled)
                    return;
                if (code !== 0) {
                    await fail(new Error(`فشل التحميل: ${stderr.slice(-200)}`));
                    return;
                }
                try {
                    const files = await (0, promises_1.readdir)(outputDir);
                    const allowedExtensions = formatId === "audio_only"
                        ? new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"])
                        : new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"]);
                    const candidates = await Promise.all(files.map(async (name) => {
                        const path = (0, node_path_1.join)(outputDir, name);
                        const fileStat = await (0, promises_1.stat)(path).catch(() => undefined);
                        const extension = (0, node_path_1.extname)(name).toLowerCase();
                        return fileStat?.isFile() && fileStat.size > 0 && allowedExtensions.has(extension)
                            ? { name, path, size: fileStat.size, extension }
                            : undefined;
                    }));
                    const mediaFiles = candidates
                        .filter((file) => Boolean(file))
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
                    let thumbnailPath;
                    if (formatId !== "audio_only") {
                        const thumbnailNames = files
                            .filter((name) => [".jpg", ".jpeg", ".png", ".webp"].includes((0, node_path_1.extname)(name).toLowerCase()))
                            .sort((a, b) => {
                            const extA = (0, node_path_1.extname)(a).toLowerCase();
                            const extB = (0, node_path_1.extname)(b).toLowerCase();
                            return (extA === ".jpg" ? 0 : 1) - (extB === ".jpg" ? 0 : 1);
                        });
                        for (const name of thumbnailNames) {
                            const path = (0, node_path_1.join)(outputDir, name);
                            const info = await (0, promises_1.stat)(path).catch(() => undefined);
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
                }
                catch (err) {
                    await fail(err instanceof Error ? err : new Error("تعذر قراءة الملف المحمّل"));
                }
            });
            proc.once("error", (err) => {
                void fail(new Error(`خطأ في التشغيل: ${err.message}`));
            });
        });
    }
    finally {
        releaseSlot();
    }
}
async function cleanupFile(filePath) {
    await (0, promises_1.rm)((0, node_path_1.dirname)(filePath), { recursive: true, force: true }).catch(() => { });
}
async function cleanupStaleDownloadDirs(maxAgeMs = 24 * 60 * 60 * 1000) {
    const { readdir, stat } = await import("node:fs/promises");
    const now = Date.now();
    const entries = await readdir(exports.DOWNLOAD_DIR, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
        const path = (0, node_path_1.join)(exports.DOWNLOAD_DIR, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info && now - info.mtimeMs > maxAgeMs) {
            await (0, promises_1.rm)(path, { recursive: true, force: true }).catch(() => { });
        }
    }));
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function formatDuration(seconds) {
    if (!seconds)
        return "غير معروف";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0)
        return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
}
//# sourceMappingURL=downloader.js.map