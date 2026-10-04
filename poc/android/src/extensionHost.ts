// Main-thread side: spawns a worker per call (as desktop's runtime.ts does) and answers its
// synchronous bridge requests with async work - native HTTP, hidden-WebView challenges.
import { HibikiBrowser, HibikiNet, isNative } from "./native";
import type { BridgeKind, BridgeReply, Transport, WorkerInbound, WorkerOutbound } from "./protocol";

export interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
  error?: string;
}

type FetchOptions = { method?: string; headers?: Record<string, string>; body?: string };

// Same defaults as desktop's netFetchHost.ts, applied only where the extension set nothing itself.
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

function withDefaultHeaders(headers: Record<string, string>): Record<string, string> {
  const present = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  const result = { ...headers };
  for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
    if (!present.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

export async function netFetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = withDefaultHeaders(options.headers ?? {});
  if (!isNative) {
    // Browser dev mode: only works for CORS-friendly endpoints, good enough to exercise the bridge.
    const response = await fetch(url, { method, headers, body: options.body });
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => (responseHeaders[key.toLowerCase()] = value));
    return { status: response.status, ok: response.ok, body: await response.text(), headers: responseHeaders };
  }
  const response = await HibikiNet.request({ url, method, headers, body: options.body, followRedirects: true, timeoutMs: 20_000 });
  // Desktop's shape: lower-cased names, one value per header, multiple Set-Cookie joined by ", ".
  const responseHeaders: Record<string, string> = {};
  for (const [name, values] of Object.entries(response.headers)) {
    responseHeaders[name.toLowerCase()] = values.join(", ");
  }
  return { status: response.status, ok: response.status >= 200 && response.status < 300, body: response.body, headers: responseHeaders };
}

async function netFetchAll(requests: Array<{ url: string; options?: FetchOptions }>): Promise<FetchResult[]> {
  return Promise.all(
    requests.map((request) =>
      netFetch(request.url, request.options).catch((error: unknown) => ({
        status: 0,
        ok: false,
        body: "",
        headers: {},
        error: error instanceof Error ? error.message : String(error),
      })),
    ),
  );
}

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|ddos-guard|один момент|проверка/i;

export function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

export async function acquireChallenge(url: string, cookieNames: string[], forceRefresh: boolean, log?: (line: string) => void) {
  const key = `challenge:${new URL(url).origin}`;
  await HibikiBrowser.open({ key, url, clearOrigin: forceRefresh });
  try {
    const deadline = Date.now() + 45_000;
    let cookies: Record<string, string> = {};
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const title = JSON.parse((await HibikiBrowser.eval({ key, js: "document.title" })).value || '""') as string;
      cookies = parseCookies((await HibikiBrowser.cookies({ url })).value);
      const haveAll = cookieNames.every((name) => name in cookies);
      log?.(`challenge: title="${title}" cookies=[${Object.keys(cookies).join(", ")}]`);
      if (haveAll && !CHALLENGE_TITLE.test(title)) break;
    }
    const userAgent = (await HibikiBrowser.userAgent()).value;
    const cookieHeader = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
    return { cookies, cookieHeader, userAgent };
  } finally {
    await HibikiBrowser.close({ key });
  }
}

async function serveBridge(kind: BridgeKind, payload: Record<string, unknown>): Promise<unknown> {
  switch (kind) {
    case "netFetch":
      return netFetch(payload.url as string, payload.options as FetchOptions | undefined);
    case "netFetchAll":
      return netFetchAll(payload.requests as Array<{ url: string; options?: FetchOptions }>);
    case "challenge":
      return acquireChallenge(payload.url as string, (payload.cookieNames as string[]) ?? [], Boolean(payload.forceRefresh));
    case "browserFetch":
      throw new Error("browserFetch is not part of the PoC");
  }
}

export interface CallOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  ms: number;
  bridgeCalls: number;
  bridgeMs: number;
}

export function runExtensionCall(
  request: Omit<WorkerInbound, "kind" | "transport">,
  transport: Transport,
  onLog: (line: string) => void,
): Promise<CallOutcome> {
  const startedAt = performance.now();
  const worker = new Worker(new URL("./extWorker.ts", import.meta.url), { type: "module" });
  let ctrl: Int32Array | null = null;
  let data: SharedArrayBuffer | null = null;
  const encoder = new TextEncoder();

  const reply = async (id: string, message: BridgeReply) => {
    const text = JSON.stringify(message);
    if (transport === "xhr") {
      await HibikiNet.bridgeResolve({ id, body: text });
      return;
    }
    if (!ctrl || !data) throw new Error("bridge reply before init");
    const bytes = encoder.encode(text);
    if (bytes.byteLength > data.byteLength) {
      if (!data.growable || bytes.byteLength > data.maxByteLength) {
        const fallback = encoder.encode(JSON.stringify({ ok: false, error: `reply too large (${bytes.byteLength}b)` }));
        new Uint8Array(data).set(fallback);
        Atomics.store(ctrl, 1, fallback.byteLength);
        Atomics.store(ctrl, 0, 1);
        Atomics.notify(ctrl, 0);
        return;
      }
      data.grow(bytes.byteLength);
    }
    new Uint8Array(data).set(bytes);
    Atomics.store(ctrl, 1, bytes.byteLength);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
  };

  return new Promise<CallOutcome>((resolve) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: "timed out after 120s", ms: performance.now() - startedAt, bridgeCalls: 0, bridgeMs: 0 });
    }, 120_000);

    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({ ok: false, error: `worker error: ${event.message}`, ms: performance.now() - startedAt, bridgeCalls: 0, bridgeMs: 0 });
    };

    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      switch (message.kind) {
        case "init":
          ctrl = new Int32Array(message.ctrl);
          data = message.data;
          break;
        case "log":
          onLog(`[ext ${message.level}] ${message.message}`);
          break;
        case "bridge": {
          const started = performance.now();
          serveBridge(message.bridgeKind, message.payload)
            .then((value) => {
              onLog(`bridge ${message.bridgeKind} ${describe(message.payload)} -> ${Math.round(performance.now() - started)}ms`);
              return reply(message.id, { ok: true, value });
            })
            .catch((error: unknown) => {
              const text = error instanceof Error ? error.message : String(error);
              onLog(`bridge ${message.bridgeKind} failed: ${text}`);
              return reply(message.id, { ok: false, error: text });
            });
          break;
        }
        case "result":
          clearTimeout(timeout);
          worker.terminate();
          resolve({
            ok: message.ok,
            value: message.ok ? message.value : undefined,
            error: message.ok ? undefined : message.error,
            ms: performance.now() - startedAt,
            bridgeCalls: message.bridgeCalls,
            bridgeMs: message.bridgeMs,
          });
          break;
      }
    };

    worker.postMessage({ kind: "call", transport, ...request } satisfies WorkerInbound);
  });
}

function describe(payload: Record<string, unknown>): string {
  if (typeof payload.url === "string") return payload.url;
  if (Array.isArray(payload.requests)) return `${payload.requests.length} requests`;
  return "";
}
