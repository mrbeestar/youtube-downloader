# بوت تحميل الفيديوهات على تيليجرام

بوت تيليجرام يتيح تحميل الفيديوهات من يوتيوب، تيك توك، فيسبوك، إنستجرام، وسناب شات بجودات متعددة.

## المميزات

- تحميل من يوتيوب، تيك توك، فيسبوك، إنستجرام، سناب شات
- اختيار الجودة: 1080p، 720p، 480p، 360p، أفضل جودة، صوت MP3
- تحميل بدون علامات مائية (تيك توك)
- اشتراك إجباري في القنوات
- لوحة تحكم للمشرفين (إحصائيات، قنوات، مشرفون، بث رسائل)
- بحث مباشر في يوتيوب
- **معرفات نتائج البحث محفوظة 30 يوماً** — أوامر `/k_ID` تعمل حتى بعد إعادة تشغيل البوت
- **روابط مشاركة الملفات** — `/start sh_xxx` يُعيد إرسال ملف سبق تحميله مباشرةً

## الأداء والتوسع

- **معالجة متوازية**: كل مستخدم مستقل — لا يتوقف البوت عند ضغط المستخدمين
- **سيمافور التحميل**: أقصى 8 تحميلات متزامنة — الزيادة تُوضع في طابور بدل إغراق الخادم
- **كاش للإعدادات**: الإعدادات تُحفظ 60 ثانية في الذاكرة — لا ضغط على DB مع كل رسالة
- **كاش للقنوات**: قائمة قنوات الاشتراك تُحفظ 30 ثانية
- **فحص الاشتراك بالتوازي**: جميع القنوات تُفحص في نفس الوقت
- **throttle لتسجيل المستخدمين**: كتابة DB مرة كل 5 دقائق فقط لنفس المستخدم
- **Connection Pool**: أقصى 20 اتصالاً متزامناً مع قاعدة البيانات

## المتطلبات

- Node.js 18+
- PostgreSQL
- yt-dlp

## التثبيت

### 1. تثبيت yt-dlp

```bash
# Linux/Mac — يُثبَّت تلقائياً في ./bin/yt-dlp عند التشغيل الأول
# أو يدوياً:
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp
```

### 2. إعداد المشروع

```bash
git clone <repo-url>
cd telegram-downloader-bot
npm install
```

### 3. إعداد متغيرات البيئة

```bash
cp .env.example .env
```

ثم عدّل ملف `.env`:

```env
BOT_TOKEN=         # توكن البوت من @BotFather
OWNER_ID=          # معرف حسابك على تيليجرام
DATABASE_URL=      # رابط قاعدة البيانات PostgreSQL
YT_DLP_PATH=       # مسار yt-dlp (افتراضي: ./bin/yt-dlp)
DOWNLOAD_DIR=      # مجلد التحميل المؤقت (افتراضي: /tmp/bot_downloads)
NODE_ENV=production
```

### 4. إنشاء جداول قاعدة البيانات

```bash
npm run db:push
```

> **ملاحظة:** يُنشئ هذا الأمر جميع الجداول بما فيها `bot_video_registry` و `bot_shared_files`.

### 5. تشغيل البوت

```bash
npm start
```

## الأوامر

| الأمر | الوصف |
|---|---|
| `/start` | بدء البوت |
| `/help` | تعليمات الاستخدام |
| `/panel` | لوحة التحكم (للمشرفين فقط) |
| `/k_<ID>` | تحميل فيديو من نتائج البحث (يعمل لمدة 30 يوماً) |

## هيكل قاعدة البيانات

| الجدول | الوصف |
|---|---|
| `bot_users` | المستخدمون |
| `bot_admins` | المشرفون |
| `bot_channels` | قنوات الاشتراك الإجباري |
| `bot_settings` | إعدادات البوت |
| `bot_download_logs` | سجل التحميلات |
| `bot_video_registry` | معرفات نتائج البحث (تُحذف بعد 30 يوماً تلقائياً) |
| `bot_shared_files` | **جديد** — ملفات الروابط المشتركة عبر `/start sh_xxx` |

## التشغيل كـ Service على Linux

```bash
sudo nano /etc/systemd/system/telegram-bot.service
```

```ini
[Unit]
Description=Telegram Downloader Bot
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/bot
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/path/to/bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot
sudo systemctl status telegram-bot
```

## التطوير

```bash
npm run dev       # تشغيل مع hot-reload
npm run build     # بناء TypeScript
npm run db:push   # رفع تغييرات Schema
```
