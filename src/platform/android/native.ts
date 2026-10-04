// The Java plugins under android/app/src/main/java/app/hibiki, as the Android adapters call them.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface HibikiNetPlugin {
  request(options: {
    id?: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
    /** 0 = no overall deadline. */
    timeoutMs?: number;
  }): Promise<{ status: number; url: string; headers: Record<string, string[]>; body: string }>;
  cancel(options: { id: string }): Promise<void>;
  registerStream(options: { headers: Record<string, string> }): Promise<{ sid: string }>;
  unregisterStream(options: { sid: string }): Promise<void>;
  bridgeResolve(options: { id: string; body: string }): Promise<void>;
}

export interface HibikiFilesPlugin {
  dataDir(): Promise<{ path: string }>;
  exists(options: { path: string }): Promise<{ value: boolean }>;
  stat(options: { path: string }): Promise<{ size?: number; mtimeMs?: number; isDirectory?: boolean; missing?: boolean }>;
  list(options: { path: string }): Promise<{ entries: string[] }>;
  readText(options: { path: string }): Promise<{ value: string }>;
  writeText(options: { path: string; value: string }): Promise<void>;
  readBytes(options: { path: string }): Promise<{ base64: string }>;
  writeBytes(options: { path: string; base64: string }): Promise<void>;
  mkdir(options: { path: string }): Promise<void>;
  remove(options: { path: string }): Promise<void>;
  rename(options: { from: string; to: string }): Promise<void>;
}

export interface HibikiDbPlugin {
  open(options: { path: string }): Promise<void>;
  close(): Promise<void>;
  exec(options: { sql: string }): Promise<void>;
  query(options: { sql: string; params: unknown[]; method: "run" | "all" | "values" | "get" }): Promise<{ rows: unknown[][] }>;
}

export interface HibikiSecurePlugin {
  isAvailable(): Promise<{ value: boolean }>;
  encrypt(options: { value: string }): Promise<{ value: string }>;
  decrypt(options: { value: string }): Promise<{ value: string }>;
}

export interface HibikiDownloadsPlugin {
  open(options: { id: string; url: string; headers?: Record<string, string> }): Promise<{ status: number; headers: Record<string, string[]>; contentLength: number }>;
  pipe(options: { id: string; filePath: string; append: boolean; buffered: boolean }): Promise<{ bytesWritten: number }>;
  cancel(options: { id: string }): Promise<void>;
  addListener(event: "progress", listener: (event: { id: string; received: number }) => void): Promise<PluginListenerHandle>;
}

export interface HibikiBrowserPlugin {
  open(options: { key: string; url: string; headers?: Record<string, string>; clearOrigin?: boolean }): Promise<void>;
  eval(options: { key: string; js: string }): Promise<{ value: string }>;
  show(options: { key: string }): Promise<void>;
  cookies(options: { url: string }): Promise<{ value: string }>;
  userAgent(): Promise<{ value: string }>;
  close(options: { key: string }): Promise<void>;
  /** A shown page the user dismissed with Back. */
  addListener(event: "closed", listener: (event: { key: string }) => void): Promise<PluginListenerHandle>;
}

export interface HibikiResolverPlugin {
  open(options: { key: string; bootScript: string; resolverScript: string }): Promise<void>;
  navigate(options: { key: string; url: string; headers?: Record<string, string>; documentOnly?: boolean }): Promise<void>;
  setDocumentOnly(options: { key: string; value: boolean }): Promise<void>;
  evalTop(options: { key: string; js: string }): Promise<{ value: string; url?: string }>;
  frames(options: { key: string }): Promise<{ frames: Array<{ id: number; url: string; origin: string; main: boolean }> }>;
  frameCall(options: { key: string; frameId: number; id: string; payload: string }): Promise<{ raw: string }>;
  takeCaptures(options: { key: string }): Promise<{ captures: Array<{ url: string; headers: Record<string, string> }> }>;
  userAgent(): Promise<{ value: string }>;
  cookies(options: { url: string }): Promise<{ value: string }>;
  close(options: { key: string }): Promise<void>;
}

export const HibikiNet = registerPlugin<HibikiNetPlugin>("HibikiNet");
export const HibikiResolver = registerPlugin<HibikiResolverPlugin>("HibikiResolver");
export const HibikiFiles = registerPlugin<HibikiFilesPlugin>("HibikiFiles");
export const HibikiDb = registerPlugin<HibikiDbPlugin>("HibikiDb");
export const HibikiSecure = registerPlugin<HibikiSecurePlugin>("HibikiSecure");
export const HibikiDownloads = registerPlugin<HibikiDownloadsPlugin>("HibikiDownloads");
export const HibikiBrowser = registerPlugin<HibikiBrowserPlugin>("HibikiBrowser");

/** An Error named like the Fetch API's, so shared code tells failures apart the same way on every platform. */
export function namedError(name: "AbortError" | "TimeoutError", message: string): Error {
  return Object.assign(new Error(message), { name });
}

/** Capacitor rejects with an object carrying the plugin's `code`. */
export function nativeCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export function nativeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
}
