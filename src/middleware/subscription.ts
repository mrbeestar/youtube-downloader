import type { Context } from "telegraf";
import { getActiveChannels } from "../db.js";
import { buildSubscribeKeyboard } from "../keyboards.js";
import { logger } from "../logger.js";

const BYPASS_COMMANDS = new Set(["/start", "/panel", "/admin"]);

export async function checkSubscription(
  ctx: Context,
  next: () => Promise<void>
): Promise<void> {
  if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
    if (ctx.callbackQuery.data === "check:sub") {
      await next();
      return;
    }
  }

  if (ctx.message && "text" in ctx.message) {
    const text = ctx.message.text?.split(" ")[0]?.split("@")[0] ?? "";
    if (BYPASS_COMMANDS.has(text)) {
      await next();
      return;
    }
  }

  const userId = ctx.from?.id;
  if (!userId) { await next(); return; }

  // يستخدم الكاش المدمج في getActiveChannels (TTL 30 ثانية)
  let channels: Awaited<ReturnType<typeof getActiveChannels>>;
  try {
    channels = await getActiveChannels();
  } catch (err) {
    logger.warn({ err }, "Could not load required channels; blocking until verification is available");
    await ctx.reply("⚠️ تعذر التحقق من الاشتراك مؤقتًا. أعد المحاولة بعد قليل.");
    return;
  }
  if (channels.length === 0) { await next(); return; }

  // فحص الاشتراك في كل القنوات بالتوازي بدل for متسلسل
  const results = await Promise.allSettled(
    channels.map(ch => ctx.telegram.getChatMember(ch.channelId, userId))
  );
  if (results.some((result) => result.status === "rejected")) {
    logger.warn({ userId }, "Required-channel membership check failed");
    await ctx.reply("⚠️ تعذر التحقق من الاشتراك مؤقتًا. تأكد من صلاحية البوت ثم أعد المحاولة.");
    return;
  }

  const notSubscribed = channels.filter((_, i) => {
    const r = results[i];
    if (r.status === "rejected") return true;
    return r.value.status === "left" ||
      r.value.status === "kicked" ||
      (r.value.status === "restricted" && !r.value.is_member);
  });

  if (notSubscribed.length === 0) { await next(); return; }

  const keyboard = buildSubscribeKeyboard(notSubscribed);
  await ctx.reply(
    `⚠️ <b>للاستمرار يجب الاشتراك في:</b>\n\n` +
    notSubscribed.map(ch => `📢 ${ch.channelTitle}`).join("\n") +
    `\n\n<i>اشترك ثم اضغط زر التحقق أدناه</i>`,
    { parse_mode: "HTML", reply_markup: keyboard.reply_markup }
  );
  // Do NOT call next() — block the request
}
