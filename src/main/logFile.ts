// The desktop log sink: core/logger.ts's lines appended to a rotating file under userData/logs.
import fs from "node:fs";
import path from "node:path";
import { log, setLogSink } from "../core/logger";

// Rotated, not truncated, so the log covering the session *before* a crash survives the restart
// that follows it - which is usually the one worth reading.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

let logFilePath: string | null = null;

/** Called once from main, after `app` is ready (userData isn't resolvable before that). */
export function initLogger(userDataDir: string): void {
  try {
    const dir = path.join(userDataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, "hibiki.log");
    if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > MAX_FILE_BYTES) {
      fs.renameSync(logFilePath, path.join(dir, "hibiki.previous.log"));
    }
    const writeStream = fs.createWriteStream(logFilePath, { flags: "a" });
    setLogSink((line) => writeStream.write(line + "\n"));
    log("info", "app", `--- session start (pid ${process.pid}) ---`);
  } catch (error) {
    // A log that can't write itself must never be the reason the app fails to start.
    console.warn("[logger] could not open the log file:", error);
  }
}

export function logFile(): string | null {
  return logFilePath;
}
