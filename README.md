# بوت تحميل الفيديوهات على تيليجرام

بوت تيليجرام يتيح تحميل الفيديوهات من يوتيوب، تيك توك، فيسبوك، إنستجرام، وسناب شات بجودات متعددة.

## المميزات

- تحميل من يوتيوب، تيك توك، فيسبوك، إنستجرام، سناب شات، X، Pinterest، وSoundCloud
- اختيار الجودة: 1080p، 720p، 480p، 360p، أفضل جودة، صوت MP3
- تحميل بدون علامات مائية (تيك توك)
- إرسال الفيديو مع صورة مصغّرة، ثم حذف الملف ورسالة التنبيه بعد ساعة
- اشتراك إجباري في القنوات
- لوحة تحكم للمشرفين (إحصائيات، قنوات، مشرفون، بث رسائل)
- بحث مباشر في يوتيوب
- **معرفات نتائج البحث محفوظة 30 يوماً** — أوامر `/k_ID` تعمل حتى بعد إعادة تشغيل البوت

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
- Python 3.10+
- PostgreSQL
- yt-dlp
- FFmpeg (لتحويل الصوت إلى MP3 ودمج مسارات الفيديو والصوت)
- Kurigram وTgCrypto لنقل الوسائط عبر MTProto

## التثبيت

تفترض أوامر الخادم أدناه أنك متصل بحساب المالك ذي صلاحية root.

### 1. تثبيت yt-dlp

```bash
# Linux/Mac — يُثبَّت تلقائياً في ./bin/yt-dlp عند التشغيل الأول
# أو يدوياً:
mkdir -p bin
curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp
# Debian/Ubuntu — مطلوب لتحويل MP3 ودمج بعض صيغ الفيديو
apt-get update && apt-get install -y ffmpeg python3-venv
```

### 2. إعداد المشروع

```bash
cd /opt/TGBots/youtube-downloader
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements-mtproto.txt
```

استخرج ملفات الأرشيف إلى المسار أعلاه، أو استبدله بمسار المشروع الذي تختاره.

### 3. إعداد متغيرات البيئة

```bash
cat > .env <<'EOF'
BOT_TOKEN=ضع_توكن_البوت_هنا
OWNER_ID=ضع_معرف_المالك_هنا
DATABASE_URL=ضع_رابط_قاعدة_البيانات_هنا
YT_DLP_PATH=./bin/yt-dlp
DOWNLOAD_DIR=/tmp/bot_downloads
TELEGRAM_API_ID=ضع_api_id_هنا
TELEGRAM_API_HASH=ضع_api_hash_هنا
NODE_ENV=production
EOF
chmod 600 .env
```

نفّذ الأوامر من مجلد المشروع، واستبدل القيم التوضيحية بقيمك. لا ترسل محتوى `.env` أو تضفه إلى Git أو أرشيف التسليم.

يستقبل `Telegraf` تحديثات البوت، بينما يرسل عامل `Kurigram` الوسائط عبر MTProto باستخدام **توكن البوت نفسه** و`TELEGRAM_API_ID` و`TELEGRAM_API_HASH`. لا يستخدم حساب مستخدم إضافيًا ولا يحفظ ملف جلسة؛ جلسة البوت مؤقتة في الذاكرة. إذا لم تضبط قيم API فلن يرسل البوت الوسائط، ولا يعود إلى رفعها عبر Bot API السحابي. خزّن القيم في Secrets ولا تضفها إلى Git أو ملفات المشروع.

تُنزل الوسائط إلى مجلد مؤقت، ثم يحذفها التطبيق بعد نجاح الإرسال أو فشله. بعد الإرسال يرسل البوت تنبيهًا لحفظ الملف في الرسائل المحفوظة، ثم يحذف الملف والتنبيه بعد ساعة. يسجل موعد الحذف في جدول PostgreSQL ذي البادئة `bot_` ليستمر بعد إعادة التشغيل. كما ينظف المجلدات اليتيمة الأقدم من 24 ساعة دوريًا وعند بدء التشغيل. لا تخزن قاعدة البيانات ملفات الفيديو.

### 4. إنشاء جداول قاعدة البيانات

```bash
npm run db:push
```

> **ملاحظة:** يُنشئ هذا الأمر الجداول المعرّفة في `src/schema.ts`، ومنها `bot_video_registry`.

### 5. تشغيل البوت

```bash
npm run build
npm prune --omit=dev
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
| `bot_scheduled_message_deletions` | مواعيد حذف ملفات تيليجرام والتنبيهات بعد ساعة |

## التشغيل كـ Service على Linux

الأوامر التالية مخصصة للتنفيذ مباشرةً من جلسة root. غيّر المسار واسم الخدمة والمستخدم إذا اخترت قيماً أخرى:

```bash
PROJECT_DIR=/opt/TGBots/youtube-downloader
SERVICE_NAME=youtube-downloader
SERVICE_USER=youtube-downloader
NODE_BIN="$(command -v node)"

id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
chown -R "$SERVICE_USER:$SERVICE_USER" "$PROJECT_DIR"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Telegram Downloader Bot
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} dist/index.js
EnvironmentFile=${PROJECT_DIR}/.env
Environment=PATH=${PROJECT_DIR}/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl status "${SERVICE_NAME}.service"
```

لمتابعة السجل:

```bash
journalctl -u youtube-downloader.service -f
```

## التطوير

```bash
npm run dev       # تشغيل مع hot-reload
npm run build     # بناء TypeScript
npm run db:push   # رفع تغييرات Schema
```
