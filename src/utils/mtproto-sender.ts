import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface TransferRequest {
  id: string;
  chatId: number;
  filePath: string;
  mediaType: "audio" | "video";
  caption: string;
  title?: string;
  performer?: string;
  duration?: number;
}

interface PendingTransfer {
  resolve(): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

let worker: ChildProcessWithoutNullStreams | undefined;
let workerReady = false;
let nextRequestId = 0;
let startPromise: Promise<boolean> | undefined;
const pendingTransfers = new Map<string, PendingTransfer>();

function failPendingTransfers(message: string): void {
  for (const pending of pendingTransfers.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  pendingTransfers.clear();
}

function handleWorkerMessage(line: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (message["type"] === "ready") {
    workerReady = true;
    return;
  }

  if (message["type"] !== "result") return;
  const id = String(message["id"] ?? "");
  const pending = pendingTransfers.get(id);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingTransfers.delete(id);
  if (message["ok"] === true) pending.resolve();
  else pending.reject(new Error(String(message["error"] || "MTProto file transfer failed")));
}

export function isMtprotoSenderReady(): boolean {
  return workerReady;
}

export async function startMtprotoSender(expectedBotId: number): Promise<boolean> {
  if (startPromise) return startPromise;

  const apiId = process.env["TELEGRAM_API_ID"]?.trim() ?? "";
  const apiHash = process.env["TELEGRAM_API_HASH"]?.trim() ?? "";
  if (!apiId && !apiHash) return false;
  if (!apiId || !apiHash) {
    throw new Error("يجب ضبط TELEGRAM_API_ID وTELEGRAM_API_HASH معًا");
  }
  if (!/^[1-9]\d*$/.test(apiId)) {
    throw new Error("TELEGRAM_API_ID يجب أن يكون رقمًا صحيحًا موجبًا");
  }

  startPromise = new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      process.env["PYTHON_BIN"] || "python3",
      ["mtproto_transfer.py"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EXPECTED_BOT_ID: String(expectedBotId),
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    worker = child;

    const stdout = createInterface({ input: child.stdout });
    let settled = false;
    const startupTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("انتهت مهلة تهيئة اتصال MTProto"));
    }, 45_000);

    stdout.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
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

export function sendMediaViaMtproto(request: Omit<TransferRequest, "id">): Promise<void> {
  if (!worker || !workerReady || !worker.stdin.writable) {
    return Promise.reject(new Error("رفع الوسائط عبر MTProto غير جاهز؛ تحقق من إعدادات API ID وAPI Hash"));
  }

  const id = `${Date.now()}-${++nextRequestId}`;
  const payload: TransferRequest = { ...request, id };

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTransfers.delete(id);
      reject(new Error("انتهت مهلة إرسال الملف عبر MTProto"));
    }, 90 * 60 * 1000);

    pendingTransfers.set(id, { resolve, reject, timeout });
    worker!.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      pendingTransfers.delete(id);
      reject(new Error("تعذر إرسال طلب الملف إلى عامل MTProto"));
    });
  });
}

export async function stopMtprotoSender(): Promise<void> {
  const child = worker;
  workerReady = false;
  worker = undefined;
  startPromise = undefined;
  failPendingTransfers("أُوقف عامل MTProto");
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
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
