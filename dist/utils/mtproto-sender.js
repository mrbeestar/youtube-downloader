"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMtprotoSenderReady = isMtprotoSenderReady;
exports.startMtprotoSender = startMtprotoSender;
exports.sendMediaViaMtproto = sendMediaViaMtproto;
exports.stopMtprotoSender = stopMtprotoSender;
const node_child_process_1 = require("node:child_process");
const node_readline_1 = require("node:readline");
let worker;
let workerReady = false;
let nextRequestId = 0;
let startPromise;
const pendingTransfers = new Map();
function failPendingTransfers(message) {
    for (const pending of pendingTransfers.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
    }
    pendingTransfers.clear();
}
function handleWorkerMessage(line) {
    let message;
    try {
        message = JSON.parse(line);
    }
    catch {
        return;
    }
    if (message["type"] === "ready") {
        workerReady = true;
        return;
    }
    if (message["type"] !== "result")
        return;
    const id = String(message["id"] ?? "");
    const pending = pendingTransfers.get(id);
    if (!pending)
        return;
    clearTimeout(pending.timeout);
    pendingTransfers.delete(id);
    if (message["ok"] === true) {
        const messageId = Number(message["messageId"]);
        if (Number.isInteger(messageId) && messageId > 0)
            pending.resolve(messageId);
        else
            pending.reject(new Error("MTProto transfer returned no Telegram message ID"));
    }
    else {
        pending.reject(new Error(String(message["error"] || "MTProto file transfer failed")));
    }
}
function isMtprotoSenderReady() {
    return workerReady;
}
async function startMtprotoSender(expectedBotId) {
    if (startPromise)
        return startPromise;
    const apiId = process.env["TELEGRAM_API_ID"]?.trim() ?? "";
    const apiHash = process.env["TELEGRAM_API_HASH"]?.trim() ?? "";
    if (!apiId && !apiHash)
        return false;
    if (!apiId || !apiHash) {
        throw new Error("يجب ضبط TELEGRAM_API_ID وTELEGRAM_API_HASH معًا");
    }
    if (!/^[1-9]\d*$/.test(apiId)) {
        throw new Error("TELEGRAM_API_ID يجب أن يكون رقمًا صحيحًا موجبًا");
    }
    startPromise = new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(process.env["PYTHON_BIN"] || "python3", ["mtproto_transfer.py"], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                EXPECTED_BOT_ID: String(expectedBotId),
                PYTHONUNBUFFERED: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        worker = child;
        const stdout = (0, node_readline_1.createInterface)({ input: child.stdout });
        let settled = false;
        const startupTimeout = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            reject(new Error("انتهت مهلة تهيئة اتصال MTProto"));
        }, 45_000);
        stdout.on("line", (line) => {
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                return;
            }
            if (message["type"] === "ready" && !settled) {
                settled = true;
                clearTimeout(startupTimeout);
                workerReady = true;
                resolve(true);
                return;
            }
            if (message["type"] === "startup_error" && !settled) {
                settled = true;
                clearTimeout(startupTimeout);
                reject(new Error(String(message["message"] || "تعذر تهيئة MTProto")));
                child.kill("SIGTERM");
                return;
            }
            handleWorkerMessage(line);
        });
        // لا نمرر مخرجات Pyrogram إلى سجل البوت لاحتمال احتوائها على معلومات اتصال.
        child.stderr.resume();
        child.once("error", (error) => {
            if (!settled) {
                settled = true;
                clearTimeout(startupTimeout);
                reject(new Error(`تعذر تشغيل عامل MTProto: ${error.message}`));
            }
        });
        child.once("exit", () => {
            workerReady = false;
            worker = undefined;
            startPromise = undefined;
            if (!settled) {
                settled = true;
                clearTimeout(startupTimeout);
                reject(new Error("توقف عامل MTProto أثناء بدء التشغيل"));
            }
            failPendingTransfers("توقف عامل MTProto أثناء نقل الملف");
        });
    });
    return startPromise;
}
function sendMediaViaMtproto(request) {
    if (!worker || !workerReady || !worker.stdin.writable) {
        return Promise.reject(new Error("رفع الوسائط عبر MTProto غير جاهز؛ تحقق من إعدادات API ID وAPI Hash"));
    }
    const id = `${Date.now()}-${++nextRequestId}`;
    const payload = { ...request, id };
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingTransfers.delete(id);
            reject(new Error("انتهت مهلة إرسال الملف عبر MTProto"));
        }, 90 * 60 * 1000);
        pendingTransfers.set(id, { resolve, reject, timeout });
        worker.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (!error)
                return;
            clearTimeout(timeout);
            pendingTransfers.delete(id);
            reject(new Error("تعذر إرسال طلب الملف إلى عامل MTProto"));
        });
    });
}
async function stopMtprotoSender() {
    const child = worker;
    workerReady = false;
    worker = undefined;
    startPromise = undefined;
    failPendingTransfers("أُوقف عامل MTProto");
    if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
        }, 5_000);
        child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
        child.stdin.end();
    });
}
//# sourceMappingURL=mtproto-sender.js.map