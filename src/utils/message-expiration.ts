import type { Context } from "telegraf";
import {
  getDueMessageDeletions,
  removeScheduledMessageDeletion,
  retryScheduledMessageDeletion,
} from "../db.js";
import { logger } from "../logger.js";

type TelegramApi = Pick<Context["telegram"], "deleteMessage">;

function telegramErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("response" in error)) return undefined;
  const response = (error as { response?: { error_code?: unknown } }).response;
  return typeof response?.error_code === "number" ? response.error_code : undefined;
}

export function startMessageExpirationWorker(telegram: TelegramApi): () => void {
  let isRunning = false;
  let isStopped = false;

  const sweep = async (): Promise<void> => {
    if (isRunning || isStopped) return;
    isRunning = true;
    try {
      const dueMessages = await getDueMessageDeletions(new Date(), 100);
      for (const item of dueMessages) {
        try {
          const deleted = await telegram.deleteMessage(item.chatId, item.messageId);
          if (!deleted) throw new Error("Telegram did not confirm message deletion");
          await removeScheduledMessageDeletion(item.id);
        } catch (error) {
          const code = telegramErrorCode(error);
          if (code === 400) {
            // Already deleted manually or no longer available; stop retrying.
            await removeScheduledMessageDeletion(item.id).catch(() => {});
            continue;
          }

          await retryScheduledMessageDeletion(item.id).catch(() => {});
          logger.warn(
            { deletionId: item.id, telegramErrorCode: code },
            "Scheduled message deletion failed; it will be retried",
          );
        }
      }
    } catch {
      logger.error("Could not load scheduled message deletions");
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => void sweep(), 15_000);
  timer.unref();
  void sweep();

  return () => {
    isStopped = true;
    clearInterval(timer);
  };
}
