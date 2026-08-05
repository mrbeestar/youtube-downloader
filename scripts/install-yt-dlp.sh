#!/bin/bash
# تحميل أحدث إصدار من yt-dlp تلقائياً عند بدء التشغيل
set -e

mkdir -p ./bin

echo "⬇️  تحميل yt-dlp..."
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o ./bin/yt-dlp

chmod +x ./bin/yt-dlp

echo "✅ yt-dlp جاهز — الإصدار: $(./bin/yt-dlp --version)"
