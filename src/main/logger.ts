// App-wide diagnostic log, kept both in memory (a ring buffer, so "export log" is instant and
// never depends on disk state) and appended to a rotating file under userData/logs, so a crash or
// a hard kill still leaves behind whatever was written before it.
//
// The reason this exists: the failures worth reporting here ("Kodik sometimes doesn't load, or
// takes ages") are intermittent, network-shaped and happen on the *user's* machine - by the time
// they're described to anyone the DevTools console is long gone. Every extension HTTP request,
// every resolver attempt and every player-link resolution now records a timed line, which makes
// the difference between "a mirror 404'd instantly" and "the TCP connect hung for 15 seconds"
// visible after the fact instead of only while attached to a debugger.
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  time: number;
  level: LogLevel;
  scope: string;
  message: string;
}

// Enough to cover a full app session's worth of interesting activity (a single episode's link
// resolution is ~20 lines) without letting a runaway loop grow the process's memory unbounded.
const MAX_ENTRIES = 5000;
// Rotated, not truncated, so the log covering the session *before* a crash survives the restart
// that follows it - which is usually the one worth reading.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const entries: LogEntry[] = [];
let logFilePath: string | null = null;
let writeStream: fs.WriteStream | null = null;
let minLevel: LogLevel = "debug";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function formatEntry(entry: LogEntry): string {
  return `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`;
}

/** Called once from main, after `app` is ready (userData isn't resolvable before that). */
export function initLogger(userDataDir: string): void {
  try {
    const dir = path.join(userDataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, "hibiki.log");
    if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > MAX_FILE_BYTES) {
      fs.renameSync(logFilePath, path.join(dir, "hibiki.previous.log"));
    }
    writeStream = fs.createWriteStream(logFilePath, { flags: "a" });
    log("info", "app", `--- session start (pid ${process.pid}) ---`);
  } catch (error) {
    // A log that can't write itself must never be the reason the app fails to start.
    console.warn("[logger] could not open the log file:", error);
  }
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, scope: string, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry: LogEntry = { time: Date.now(), level, scope, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const line = formatEntry(entry);
  writeStream?.write(line + "\n");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
}

export const logger = {
  debug: (scope: string, message: string) => log("debug", scope, message),
  info: (scope: string, message: string) => log("info", scope, message),
  warn: (scope: string, message: string) => log("warn", scope, message),
  error: (scope: string, message: string) => log("error", scope, message),
};

export function recentEntries(limit = MAX_ENTRIES): LogEntry[] {
  return entries.slice(-limit);
}

/** The whole in-memory log as one plain-text document, newest last - what "export log" writes. */
export function renderLog(header: Record<string, string> = {}): string {
  const head = Object.entries(header).map(([key, value]) => `# ${key}: ${value}`);
  return [...head, "", ...entries.map(formatEntry), ""].join("\n");
}

export function logFile(): string | null {
  return logFilePath;
}
