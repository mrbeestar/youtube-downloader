import type { Context } from "telegraf";
import {
  getUserStats,
  getAdmins,
  addAdmin,
  removeAdmin,
  getAllChannels,
  addChannel,
  toggleChannel,
  getSettings,
  toggleSetting,
  setSetting,
  isAdmin,
  getAllUserIds,
} from "../db.js";
import {
  buildAdminMainKeyboard,
  buildPlatformsKeyboard,
  buildChannelsKeyboard,
  buildAdminsKeyboard,
} from "../keyboards.js";
import { logger } from "../logger.js";

const PLATFORM_LABELS: Record<string, string> = {
  youtube_enabled:  "يوتيوب",
  tiktok_enabled:   "تيك توك",
  facebook_enabled: "فيسبوك",
  instagram_enabled:"إنستجرام",
  snapchat_enabled: "سناب شات",
  x_enabled:        "X",
  pinterest_enabled:"Pinterest",
  soundcloud_enabled: "SoundCloud",
};

const awaitingState = new Map<number, { type: string; data?: unknown }>();

export function setAwaitingState(userId: number, state: { type: string; data?: unknown }): void {
  awaitingState.set(userId, state);
}

export function getAwaitingState(userId: number): { type: string; data?: unknown } | undefined {
  return awaitingState.get(userId);
}

export function clearAwaitingState(userId: number): void {
  awaitingState.delete(userId);
}

export async function sendAdminPanel(ctx: Context): Promise<void> {
  const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
  const userId  = ctx.from?.id;
  if (!userId || (userId !== ownerId && !(await isAdmin(userId)))) return;

  const stats = await getUserStats();
  const text =
    `🎛 <b>لوحة التحكم</b>\n\n` +
    `👥 المستخدمون: <b>${stats.totalUsers.toLocaleString()}</b>\n` +
    `⬇️ إجمالي التحميلات: <b>${stats.totalDownloads.toLocaleString()}</b>\n` +
    `🚫 المحظورون: <b>${stats.bannedUsers.toLocaleString()}</b>\n\n` +
    `اختر من القائمة:`;

  const keyboard = buildAdminMainKeyboard();

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard.reply_markup }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard.reply_markup });
  }
}

export async function handleAdminCallback(ctx: Context, action: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
  if (userId !== ownerId && !(await isAdmin(userId))) {
    await ctx.answerCbQuery("⛔ ليس لديك صلاحية");
    return;
  }

  await ctx.answerCbQuery();

  if (action === "main")  { await sendAdminPanel(ctx); return; }
  if (action === "close") { await ctx.deleteMessage().catch(() => {}); return; }

  if (action === "stats") {
    const stats = await getUserStats();
    await ctx.editMessageText(
      `📊 <b>إحصائيات البوت</b>\n\n` +
      `👥 إجمالي المستخدمين: <b>${stats.totalUsers.toLocaleString()}</b>\n` +
      `⬇️ إجمالي التحميلات: <b>${stats.totalDownloads.toLocaleString()}</b>\n` +
      `🚫 المحظورون: <b>${stats.bannedUsers.toLocaleString()}</b>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 رجوع", callback_data: "admin:main" }]] } }
    ).catch(() => {});
    return;
  }

  if (action === "platforms") {
    const settings = await getSettings();
    await ctx.editMessageText(
      `🌐 <b>تشغيل/إيقاف المواقع</b>\n\nاضغط على الموقع لتغيير حالته:`,
      { parse_mode: "HTML", reply_markup: buildPlatformsKeyboard(settings).reply_markup }
    ).catch(() => {});
    return;
  }

  if (action.startsWith("toggle:")) {
    const key         = action.replace("toggle:", "");
    const newState    = await toggleSetting(key);
    const platformName = PLATFORM_LABELS[key] || key;
    await ctx.answerCbQuery(`${newState ? "✅ تم تفعيل" : "❌ تم إيقاف"} ${platformName}`);
    const settings = await getSettings();
    await ctx.editMessageReplyMarkup(buildPlatformsKeyboard(settings).reply_markup).catch(() => {});
    return;
  }

  if (action === "channels") {
    const channels = await getAllChannels();
    await ctx.editMessageText(
      `📢 <b>قنوات الاشتراك الإجباري</b>\n\n` +
      (channels.length === 0 ? "لا توجد قنوات مضافة بعد" : `لديك ${channels.length} قناة(ات)`),
      { parse_mode: "HTML", reply_markup: buildChannelsKeyboard(channels).reply_markup }
    ).catch(() => {});
    return;
  }

  if (action.startsWith("ch:toggle:")) {
    const id = parseInt(action.replace("ch:toggle:", ""), 10);
    const newState = await toggleChannel(id);
    await ctx.answerCbQuery(newState ? "✅ تم تفعيل القناة" : "❌ تم إيقاف القناة");
    const channels = await getAllChannels();
    await ctx.editMessageReplyMarkup(buildChannelsKeyboard(channels).reply_markup).catch(() => {});
    return;
  }

  if (action === "ch:add") {
    setAwaitingState(userId, { type: "add_channel" });
    await ctx.editMessageText(
      `📢 <b>إضافة قناة اشتراك إجباري</b>\n\n` +
      `أرسل معرف القناة أو رسالة محولة من القناة\n\n` +
      `<i>مثال: @mychannel أو -1001234567890</i>\n\n` +
      `تأكد أن البوت مضاف كمشرف في القناة`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "admin:channels" }]] } }
    ).catch(() => {});
    return;
  }

  if (action === "admins") {
    const admins = await getAdmins();
    await ctx.editMessageText(
      `👥 <b>المشرفون</b>\n\n` +
      (admins.length === 0 ? "لا يوجد مشرفون مضافون" : `لديك ${admins.length} مشرف(ين)`),
      { parse_mode: "HTML", reply_markup: buildAdminsKeyboard(admins).reply_markup }
    ).catch(() => {});
    return;
  }

  if (action === "adm:add") {
    setAwaitingState(userId, { type: "add_admin" });
    await ctx.editMessageText(
      `👤 <b>إضافة مشرف</b>\n\n` +
      `أرسل معرف المستخدم (User ID) لإضافته كمشرف\n\n` +
      `<i>يمكن الحصول على المعرف عبر @userinfobot</i>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "admin:admins" }]] } }
    ).catch(() => {});
    return;
  }

  if (action.startsWith("adm:info:")) {
    const adminId = Number(action.slice("adm:info:".length));
    if (!Number.isSafeInteger(adminId) || adminId <= 0) {
      await ctx.answerCbQuery("معرف المشرف غير صالح");
      return;
    }
    const admin = (await getAdmins()).find((item) => item.id === adminId);
    if (!admin) {
      await ctx.answerCbQuery("لم يعد هذا المستخدم مشرفًا");
      return;
    }
    const escapeHtml = (value: string) =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await ctx.editMessageText(
      `👤 <b>بيانات المشرف</b>\n\n` +
      `الاسم: ${escapeHtml(admin.firstName)}\n` +
      `المعرف: ${admin.username ? `@${escapeHtml(admin.username)}` : "غير متاح"}\n` +
      `الآيدي: <code>${admin.id}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 رجوع", callback_data: "admin:admins" }]],
        },
      },
    ).catch(() => {});
    return;
  }

  if (action.startsWith("adm:remove:")) {
    if (userId !== ownerId) {
      await ctx.answerCbQuery("⛔ فقط المالك يمكنه حذف المشرفين");
      return;
    }
    const admId = parseInt(action.replace("adm:remove:", ""), 10);
    await removeAdmin(admId);
    const admins = await getAdmins();
    await ctx.answerCbQuery("✅ تم حذف المشرف");
    await ctx.editMessageReplyMarkup(buildAdminsKeyboard(admins).reply_markup).catch(() => {});
    return;
  }

  if (action === "welcome") {
    const settings = await getSettings();
    const current  = settings["welcome_message"] || "";
    setAwaitingState(userId, { type: "set_welcome" });
    await ctx.editMessageText(
      `✏️ <b>تعيين رسالة الترحيب</b>\n\n` +
      `أرسل النص الجديد لرسالة الترحيب التي تظهر عند /start\n\n` +
      (current ? `<b>الرسالة الحالية:</b>\n<code>${current.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</code>\n\n` : "") +
      `<b>📌 المتغيرات المتاحة:</b>\n` +
      `• <code>#name</code> — الاسم الأول للمستخدم\n` +
      `• <code>#username</code> — اليوزرنيم مع رابطه (قابل للضغط)\n` +
      `• <code>#userid</code> — الآيدي الرقمي\n\n` +
      `<b>🎨 التنسيق المدعوم:</b>\n` +
      `• HTML: <code>&lt;b&gt;عريض&lt;/b&gt;</code> ، <code>&lt;i&gt;مائل&lt;/i&gt;</code> ، <code>&lt;code&gt;كود&lt;/code&gt;</code>\n` +
      `• MarkdownV2: <code>*عريض*</code> ، <code>_مائل_</code> ، <code>\`كود\`</code>\n` +
      `• نص عادي بدون تنسيق`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "admin:main" }]] } }
    ).catch(() => {});
    return;
  }

  if (action === "broadcast") {
    setAwaitingState(userId, { type: "broadcast" });
    await ctx.editMessageText(
      `📣 <b>إرسال رسالة جماعية</b>\n\n` +
      `أرسل الرسالة التي تريد إيصالها لجميع المستخدمين\n\n` +
      `<i>يمكنك استخدام HTML للتنسيق</i>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "admin:main" }]] } }
    ).catch(() => {});
    return;
  }
}

export async function handleAwaitingInput(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const state = getAwaitingState(userId);
  if (!state) return false;

  const text = ctx.text || "";

  if (state.type === "add_channel") {
    clearAwaitingState(userId);
    try {
      let chatId: number | string = text.trim();
      if (!chatId.startsWith("@")) chatId = parseInt(text.trim(), 10);

      const chat = await ctx.telegram.getChat(chatId);
      if (chat.type !== "channel" && chat.type !== "supergroup") {
        await ctx.reply("❌ هذا ليس قناة أو مجموعة. أرسل معرف قناة صحيح.");
        return true;
      }

      let inviteLink: string | undefined;
      try { inviteLink = await ctx.telegram.exportChatInviteLink(chat.id); } catch {}

      const username = "username" in chat ? (chat as { username?: string }).username : undefined;
      const title    = "title"    in chat ? (chat as { title: string }).title    : `قناة ${(chat as { id: number }).id}`;

      await addChannel({ channelId: chat.id, channelUsername: username, channelTitle: title, inviteLink });
      await ctx.reply(
        `✅ <b>تمت إضافة القناة بنجاح</b>\n\n📢 ${title}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 العودة لإدارة القنوات", callback_data: "admin:channels" }]] } }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "خطأ";
      await ctx.reply(
        `❌ فشل إضافة القناة\n` +
        (msg.includes("not found") || msg.includes("PEER_ID_INVALID")
          ? "تأكد أن البوت مشرف في القناة وأن المعرف صحيح"
          : msg.slice(0, 200))
      );
    }
    return true;
  }

  if (state.type === "add_admin") {
    clearAwaitingState(userId);
    const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
    if (userId !== ownerId) { await ctx.reply("⛔ فقط المالك يمكنه إضافة مشرفين"); return true; }

    const newAdminId = parseInt(text.trim(), 10);
    if (isNaN(newAdminId)) { await ctx.reply("❌ معرف المستخدم غير صحيح، أرسل رقماً صحيحاً"); return true; }
    if (newAdminId === ownerId) { await ctx.reply("❌ أنت المالك بالفعل!"); return true; }

    try {
      await addAdmin(newAdminId, "مشرف", undefined, userId);
      await ctx.reply(
        `✅ تمت إضافة المستخدم <code>${newAdminId}</code> كمشرف`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 العودة للمشرفين", callback_data: "admin:admins" }]] } }
      );
    } catch { await ctx.reply("❌ فشل إضافة المشرف"); }
    return true;
  }

  if (state.type === "set_welcome") {
    clearAwaitingState(userId);
    const msg = text.trim();
    if (!msg) { await ctx.reply("❌ الرسالة فارغة"); return true; }
    await setSetting("welcome_message", msg);
    await ctx.reply(
      `✅ <b>تم تحديث رسالة الترحيب بنجاح</b>\n\n<b>معاينة:</b>\n${msg}`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 رجوع للوحة التحكم", callback_data: "admin:main" }]] } }
    );
    return true;
  }

  if (state.type === "broadcast") {
    clearAwaitingState(userId);
    const message = text.trim();
    if (!message) { await ctx.reply("❌ الرسالة فارغة"); return true; }

    const statusMsg = await ctx.reply("📣 جاري الإرسال...");
    const userIds   = await getAllUserIds();
    let success = 0, failed = 0;

    for (const uid of userIds) {
      try {
        await ctx.telegram.sendMessage(uid, `📣 <b>إعلان من البوت</b>\n\n${message}`, { parse_mode: "HTML" });
        success++;
      } catch { failed++; }
      if ((success + failed) % 25 === 0) await new Promise(r => setTimeout(r, 1000));
    }

    await ctx.telegram.editMessageText(
      ctx.chat!.id, statusMsg.message_id, undefined,
      `✅ <b>تم إرسال الرسالة الجماعية</b>\n\n✅ نجح: ${success}\n❌ فشل: ${failed}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return true;
  }

  return false;
}
