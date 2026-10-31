"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMessageExpirationWorker = startMessageExpirationWorker;
const db_js_1 = require("../db.js");
const logger_js_1 = require("../logger.js");
function telegramErrorCode(error) {
    if (!error || typeof error !== "object" || !("response" in error))
        return undefined;
    const response = error.response;
    return typeof response?.error_code === "number" ? response.error_code : undefined;
}
function startMessageExpirationWorker(telegram) {
    let isRunning = false;
    const sweep = async () => {
        if (isRunning)
            return;
        isRunning = true;
        try {
            const dueMessages = await (0, db_js_1.getDueMessageDeletions)(new Date(), 100);
            for (const item of dueMessages) {
                try {
                    const deleted = await telegram.deleteMessage(item.chatId, item.messageId);
                    if (!deleted)
                        throw new Error("Telegram did not confirm message deletion");
                    await (0, db_js_1.removeScheduledMessageDeletion)(item.id);
                }
                catch (error) {
                    const code = telegramErrorCode(error);
                    if (code === 400) {
                        // Already deleted manually or no longer available; stop retrying.
                        await (0, db_js_1.removeScheduledMessageDeletion)(item.id).catch(() => { });
                        continue;
                    }
                    await (0, db_js_1.retryScheduledMessageDeletion)(item.id).catch(() => { });
                    logger_js_1.logger.warn({ deletionId: item.id, telegramErrorCode: code }, "Scheduled message deletion failed; it will be retried");
                }
            }
        }
        catch {
            logger_js_1.logger.error("Could not load scheduled message deletions");
        }
        finally {
            isRunning = false;
        }
    };
    const timer = setInterval(() => void sweep(), 15_000);
    timer.unref();
    void sweep();
}
//# sourceMappingURL=message-expiration.js.map