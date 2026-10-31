import asyncio
import json
import logging
import os
import sys
import tempfile
from pathlib import Path

from pyrogram import Client
from pyrogram.enums import ParseMode


logging.basicConfig(stream=sys.stderr, level=logging.ERROR)


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def safe_error(error):
    message = str(error)
    for secret_name in ("BOT_TOKEN", "TELEGRAM_API_HASH"):
        secret = os.environ.get(secret_name)
        if secret:
            message = message.replace(secret, "[REDACTED]")
    return message[:400]


async def extract_audio_thumbnail(audio_path: Path, output_path: Path):
    for quality in ("4", "8", "12"):
        output_path.unlink(missing_ok=True)
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(audio_path),
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=320:320:force_original_aspect_ratio=decrease",
                "-q:v",
                quality,
                str(output_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await process.communicate()
        except FileNotFoundError:
            logging.warning("ffmpeg is unavailable; sending audio without a cover thumbnail")
            return None

        if process.returncode == 0 and output_path.is_file():
            size = output_path.stat().st_size
            if 0 < size <= 200 * 1024:
                return output_path

    logging.warning("No Telegram-ready embedded cover was found for the audio")
    return None


async def prepare_video_thumbnail(source_path: Path, output_path: Path, extract_from_video=False):
    for quality in ("4", "8", "12"):
        output_path.unlink(missing_ok=True)
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
        ]
        if extract_from_video:
            command.extend(["-ss", "0.5"])
        command.extend([
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=320:320:force_original_aspect_ratio=decrease",
            "-q:v",
            quality,
            str(output_path),
        ])
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await process.communicate()
        except FileNotFoundError:
            logging.warning("ffmpeg is unavailable; sending video without a cover thumbnail")
            return None

        if process.returncode == 0 and output_path.is_file():
            size = output_path.stat().st_size
            if 0 < size <= 200 * 1024:
                return output_path

    return None


async def main():
    token = os.environ.get("BOT_TOKEN", "").strip()
    api_id_value = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()
    expected_bot_id = os.environ.get("EXPECTED_BOT_ID", "").strip()

    if not token or not api_id_value or not api_hash:
        emit({"type": "startup_error", "message": "MTProto credentials are not configured"})
        return 2

    try:
        api_id = int(api_id_value)
        if api_id <= 0:
            raise ValueError("invalid api id")
    except ValueError:
        emit({"type": "startup_error", "message": "TELEGRAM_API_ID must be a positive integer"})
        return 2

    if not expected_bot_id.isdigit():
        emit({"type": "startup_error", "message": "Expected bot identity is unavailable"})
        return 2

    client = Client(
        "youtube-downloader-transfer",
        api_id=api_id,
        api_hash=api_hash,
        bot_token=token,
        in_memory=True,
    )

    try:
        await client.start()
        bot = await client.get_me()
        if str(bot.id) != expected_bot_id:
            emit({"type": "startup_error", "message": "MTProto bot identity does not match BOT_TOKEN"})
            return 3

        emit({"type": "ready", "bot_id": bot.id})

        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break

            request = {}
            try:
                request = json.loads(line)
                request_id = str(request["id"])
                chat_id = int(request["chatId"])
                file_path = Path(str(request["filePath"]))
                media_type = str(request["mediaType"])
                caption = str(request.get("caption", ""))

                if not file_path.is_file():
                    raise FileNotFoundError("Downloaded media file is missing")

                if media_type == "audio":
                    performer = str(request.get("performer", "")).strip()[:64] or None
                    duration = max(0, int(float(request.get("duration", 0) or 0)))
                    with tempfile.TemporaryDirectory(prefix="audio-cover-") as temp_dir:
                        thumbnail_path = await extract_audio_thumbnail(
                            file_path,
                            Path(temp_dir) / "cover.jpg",
                        )
                        message = await client.send_audio(
                            chat_id=chat_id,
                            audio=str(file_path),
                            caption=caption,
                            parse_mode=ParseMode.DISABLED,
                            duration=duration,
                            performer=performer,
                            title=str(request.get("title", ""))[:64],
                            thumb=str(thumbnail_path) if thumbnail_path else None,
                        )
                elif media_type == "video":
                    with tempfile.TemporaryDirectory(prefix="video-cover-") as temp_dir:
                        cover_path = Path(temp_dir) / "cover.jpg"
                        thumbnail_path = request.get("thumbnailPath")
                        thumbnail = None
                        if thumbnail_path:
                            thumbnail_source = Path(str(thumbnail_path))
                            if thumbnail_source.is_file():
                                thumbnail = await prepare_video_thumbnail(
                                    thumbnail_source,
                                    cover_path,
                                )
                        if thumbnail is None:
                            thumbnail = await prepare_video_thumbnail(
                                file_path,
                                cover_path,
                                extract_from_video=True,
                            )
                        message = await client.send_video(
                            chat_id=chat_id,
                            video=str(file_path),
                            caption=caption,
                            supports_streaming=True,
                            thumb=str(thumbnail) if thumbnail else None,
                        )
                else:
                    raise ValueError("Unsupported media type")

                emit({
                    "type": "result",
                    "id": request_id,
                    "ok": True,
                    "messageId": message.id,
                })
            except Exception as error:
                request_id = str(request.get("id", "")) if isinstance(request, dict) else ""
                emit({
                    "type": "result",
                    "id": request_id,
                    "ok": False,
                    "error": safe_error(error),
                })
    except Exception as error:
        emit({"type": "startup_error", "message": safe_error(error)})
        return 4
    finally:
        if client.is_connected:
            await client.stop()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
