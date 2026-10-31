"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFormatKeyboard = buildFormatKeyboard;
exports.buildAdminMainKeyboard = buildAdminMainKeyboard;
exports.buildPlatformsKeyboard = buildPlatformsKeyboard;
exports.buildChannelsKeyboard = buildChannelsKeyboard;
exports.buildAdminsKeyboard = buildAdminsKeyboard;
exports.buildSubscribeKeyboard = buildSubscribeKeyboard;
const telegraf_1 = require("telegraf");
function buildFormatKeyboard(info, msgId) {
    const buttons = [];
    let row = [];
    for (let i = 0; i < info.formats.length; i++) {
        const fmt = info.formats[i];
        row.push(telegraf_1.Markup.button.callback(fmt.label, `dl:${msgId}:${fmt.id}`));
        if (row.length === 2) {
            buttons.push(row);
            row = [];
        }
    }
    if (row.length > 0)
        buttons.push(row);
    buttons.push([telegraf_1.Markup.button.callback("❌ إلغاء", "cancel")]);
    return telegraf_1.Markup.inlineKeyboard(buttons);
}
function buildAdminMainKeyboard() {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback("📊 الإحصائيات", "admin:stats")],
        [telegraf_1.Markup.button.callback("📢 قنوات الاشتراك الإجباري", "admin:channels")],
        [telegraf_1.Markup.button.callback("👥 المشرفون", "admin:admins")],
        [telegraf_1.Markup.button.callback("🌐 تشغيل/إيقاف المواقع", "admin:platforms")],
        [telegraf_1.Markup.button.callback("✏️ تعيين رسالة الترحيب", "admin:welcome")],
        [telegraf_1.Markup.button.callback("📣 إرسال رسالة جماعية", "admin:broadcast")],
        [telegraf_1.Markup.button.callback("❌ إغلاق", "admin:close")],
    ]);
}
function buildPlatformsKeyboard(settings) {
    const platforms = [
        { key: "youtube_enabled", label: "يوتيوب" },
        { key: "tiktok_enabled", label: "تيك توك" },
        { key: "facebook_enabled", label: "فيسبوك" },
        { key: "instagram_enabled", label: "إنستجرام" },
        { key: "snapchat_enabled", label: "سناب شات" },
        { key: "x_enabled", label: "X" },
        { key: "pinterest_enabled", label: "Pinterest" },
        { key: "soundcloud_enabled", label: "SoundCloud" },
    ];
    const rows = platforms.map(p => {
        const enabled = settings[p.key] !== "false";
        return [telegraf_1.Markup.button.callback(`${enabled ? "✅" : "❌"} ${p.label}`, `admin:toggle:${p.key}`)];
    });
    rows.push([telegraf_1.Markup.button.callback("🔙 رجوع", "admin:main")]);
    return telegraf_1.Markup.inlineKeyboard(rows);
}
function buildChannelsKeyboard(channels) {
    const rows = channels.map(ch => [
        telegraf_1.Markup.button.callback(`${ch.isActive ? "✅" : "❌"} ${ch.channelTitle}`, `admin:ch:toggle:${ch.id}`),
    ]);
    rows.push([telegraf_1.Markup.button.callback("➕ إضافة قناة", "admin:ch:add")]);
    rows.push([telegraf_1.Markup.button.callback("🔙 رجوع", "admin:main")]);
    return telegraf_1.Markup.inlineKeyboard(rows);
}
function buildAdminsKeyboard(admins) {
    const rows = admins.map(adm => {
        const name = adm.username ? `@${adm.username}` : adm.firstName;
        return [
            telegraf_1.Markup.button.callback(`👤 ${name}`, `admin:adm:info:${adm.id}`),
            telegraf_1.Markup.button.callback("🗑 حذف", `admin:adm:remove:${adm.id}`),
        ];
    });
    rows.push([telegraf_1.Markup.button.callback("➕ إضافة مشرف", "admin:adm:add")]);
    rows.push([telegraf_1.Markup.button.callback("🔙 رجوع", "admin:main")]);
    return telegraf_1.Markup.inlineKeyboard(rows);
}
function buildSubscribeKeyboard(channels) {
    const rows = channels.map(ch => {
        const url = ch.channelUsername
            ? `https://t.me/${ch.channelUsername.replace("@", "")}`
            : ch.inviteLink || "https://t.me/";
        return [telegraf_1.Markup.button.url(`📢 ${ch.channelTitle}`, url)];
    });
    rows.push([telegraf_1.Markup.button.callback("✅ تحققت من الاشتراك", "check:sub")]);
    return telegraf_1.Markup.inlineKeyboard(rows);
}
//# sourceMappingURL=keyboards.js.map