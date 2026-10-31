import { Markup } from "telegraf";
import type { VideoInfo } from "./utils/downloader.js";

export function buildFormatKeyboard(info: VideoInfo, msgId: string) {
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  let row: ReturnType<typeof Markup.button.callback>[] = [];

  for (let i = 0; i < info.formats.length; i++) {
    const fmt = info.formats[i];
    row.push(Markup.button.callback(fmt.label, `dl:${msgId}:${fmt.id}`));
    if (row.length === 2) {
      buttons.push(row);
      row = [];
    }
  }
  if (row.length > 0) buttons.push(row);
  buttons.push([Markup.button.callback("❌ إلغاء", "cancel")]);

  return Markup.inlineKeyboard(buttons);
}

export function buildAdminMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 الإحصائيات",              "admin:stats")],
    [Markup.button.callback("📢 قنوات الاشتراك الإجباري", "admin:channels")],
    [Markup.button.callback("👥 المشرفون",                "admin:admins")],
    [Markup.button.callback("🌐 تشغيل/إيقاف المواقع",    "admin:platforms")],
    [Markup.button.callback("✏️ تعيين رسالة الترحيب",    "admin:welcome")],
    [Markup.button.callback("📣 إرسال رسالة جماعية",      "admin:broadcast")],
    [Markup.button.callback("❌ إغلاق",                   "admin:close")],
  ]);
}

export function buildPlatformsKeyboard(settings: Record<string, string>) {
  const platforms = [
    { key: "youtube_enabled",   label: "يوتيوب"    },
    { key: "tiktok_enabled",    label: "تيك توك"   },
    { key: "facebook_enabled",  label: "فيسبوك"    },
    { key: "instagram_enabled", label: "إنستجرام"  },
    { key: "snapchat_enabled",  label: "سناب شات"  },
    { key: "x_enabled",         label: "X"          },
    { key: "pinterest_enabled", label: "Pinterest"  },
    { key: "soundcloud_enabled",label: "SoundCloud" },
  ];

  const rows = platforms.map(p => {
    const enabled = settings[p.key] !== "false";
    return [Markup.button.callback(`${enabled ? "✅" : "❌"} ${p.label}`, `admin:toggle:${p.key}`)];
  });
  rows.push([Markup.button.callback("🔙 رجوع", "admin:main")]);
  return Markup.inlineKeyboard(rows);
}

export function buildChannelsKeyboard(
  channels: Array<{ id: number; channelTitle: string; isActive: boolean }>
) {
  const rows = channels.map(ch => [
    Markup.button.callback(
      `${ch.isActive ? "✅" : "❌"} ${ch.channelTitle}`,
      `admin:ch:toggle:${ch.id}`
    ),
  ]);
  rows.push([Markup.button.callback("➕ إضافة قناة", "admin:ch:add")]);
  rows.push([Markup.button.callback("🔙 رجوع", "admin:main")]);
  return Markup.inlineKeyboard(rows);
}

export function buildAdminsKeyboard(
  admins: Array<{ id: number; firstName: string; username: string | null }>
) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = admins.map(adm => {
    const name = adm.username ? `@${adm.username}` : adm.firstName;
    return [
      Markup.button.callback(`👤 ${name}`,  `admin:adm:info:${adm.id}`),
      Markup.button.callback("🗑 حذف",      `admin:adm:remove:${adm.id}`),
    ];
  });
  rows.push([Markup.button.callback("➕ إضافة مشرف", "admin:adm:add")]);
  rows.push([Markup.button.callback("🔙 رجوع", "admin:main")]);
  return Markup.inlineKeyboard(rows);
}

export function buildSubscribeKeyboard(
  channels: Array<{
    channelUsername: string | null;
    channelTitle: string;
    inviteLink: string | null;
  }>
) {
  const rows: (ReturnType<typeof Markup.button.url> | ReturnType<typeof Markup.button.callback>)[][] =
    channels.map(ch => {
      const url = ch.channelUsername
        ? `https://t.me/${ch.channelUsername.replace("@", "")}`
        : ch.inviteLink || "https://t.me/";
      return [Markup.button.url(`📢 ${ch.channelTitle}`, url)];
    });
  rows.push([Markup.button.callback("✅ تحققت من الاشتراك", "check:sub")]);
  return Markup.inlineKeyboard(rows);
}
