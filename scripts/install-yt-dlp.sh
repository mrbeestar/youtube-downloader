#!/bin/bash
# تحميل أحدث إصدار من yt-dlp تلقائياً
set -e

mkdir -p ./bin

URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"

echo "⬇️  تحميل yt-dlp..."
if command -v curl &>/dev/null; then
  curl -fsSL "$URL" -o ./bin/yt-dlp
elif command -v wget &>/dev/null; then
  wget -q "$URL" -O ./bin/yt-dlp
else
  echo "❌ curl و wget غير متوفران — سيتولى Node.js التحميل عند التشغيل"
  exit 0
fi

chmod +x ./bin/yt-dlp
echo "✅ yt-dlp جاهز — الإصدار: $(./bin/yt-dlp --version)"
