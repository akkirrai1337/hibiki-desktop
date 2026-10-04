/// <reference lib="webworker" />
// Runs one extension call, exactly like desktop's worker.ts + execute.ts, but in a Web Worker.
// The globals are desktop's own buildExtensionGlobals (src/main/extensions/globals.ts), unchanged.
import { Buffer } from "buffer";
import { buildExtensionGlobals } from "../../../src/main/extensions/globals";
import type { BridgeKind, BridgeReply, Transport, WorkerInbound, WorkerOutbound } from "./protocol";

// globals.ts (Base64/Url bindings) reads Buffer at call time, never at import time, so installing
// it here - after the hoisted imports have run - is early enough.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: WorkerOutbound) => scope.postMessage(message);

let transport: Transport = "sab";
let ctrl: Int32Array | null = null;
let data: SharedArrayBuffer | null = null;
let bridgeCalls = 0;
let bridgeMs = 0;
let nextId = 0;

function initSab(): void {
  ctrl = new Int32Array(new SharedArrayBuffer(8));
  // Growable, so a large reply (a full HTML page, a big JSON catalog) never needs a second round
  // trip: the main thread grows it to fit before writing. 1 MiB covers nearly every response.
  data = new SharedArrayBuffer(1 << 20, { maxByteLength: 256 << 20 });
  post({ kind: "init", ctrl: ctrl.buffer as SharedArrayBuffer, data });
}

function callHostSync<T>(bridgeKind: BridgeKind, payload: Record<string, unknown>): T {
  const startedAt = performance.now();
  const id = `${Date.now().toString(36)}-${(nextId++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let text: string;
  if (transport === "sab") {
    if (!ctrl || !data) throw new Error("SAB transport not initialised");
    Atomics.store(ctrl, 0, 0);
    post({ kind: "bridge", id, bridgeKind, payload });
    Atomics.wait(ctrl, 0, 0);
    const length = ctrl[1];
    // TextDecoder refuses views over shared memory - copy out first.
    text = new TextDecoder().decode(new Uint8Array(data, 0, length).slice());
  } else {
    post({ kind: "bridge", id, bridgeKind, payload });
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/_hibiki/bridge/${id}`, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`bridge XHR failed with HTTP ${xhr.status}`);
    text = xhr.responseText;
  }
  bridgeCalls += 1;
  bridgeMs += performance.now() - startedAt;
  const reply = JSON.parse(text) as BridgeReply;
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as T;
}

function stringify(message: unknown): string {
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function loadProvider(script: string): Record<string, unknown> {
  const globals = buildExtensionGlobals({
    logger: {
      log: (m) => post({ kind: "log", level: "log", message: stringify(m) }),
      warn: (m) => post({ kind: "log", level: "warn", message: stringify(m) }),
      error: (m) => post({ kind: "log", level: "error", message: stringify(m) }),
    },
    preferredLanguage: "ru",
    netFetch: {
      fetch: (url, options) => callHostSync("netFetch", { url, options }),
      fetchAll: (requests) => callHostSync("netFetchAll", { requests }),
    },
    challenge: {
      acquire: (url, cookieNames, forceRefresh) => callHostSync("challenge", { url, cookieNames, forceRefresh }),
    },
    browserFetch: {
      fetch: (pageUrl, targetUrl, options) => callHostSync("browserFetch", { pageUrl, targetUrl, options }),
    },
  }) as Record<string, unknown>;

  // Desktop compiles with node:vm into a context built from these globals; here they become the
  // parameters of a Function, which also catches a top-level `const Provider` (vm would not).
  const names = Object.keys(globals);
  const factory = new Function(...names, `${script}\n;return typeof Provider !== "undefined" ? Provider : undefined;`);
  const provider = factory(...names.map((name) => globals[name])) as Record<string, unknown> | undefined;
  if (!provider) throw new Error("Extension did not define a Provider object");
  return provider;
}

function invoke(provider: Record<string, unknown>, sourceId: string, method: string, args: unknown[]): unknown {
  const fn = provider[method];
  if (typeof fn !== "function") throw new Error(`Provider has no ${method}()`);
  const tag = (item: unknown) => (item && typeof item === "object" ? { ...item, sourceId } : item);
  switch (method) {
    case "search":
      return (fn.call(provider, JSON.stringify(args[0])) as unknown[]).map(tag);
    case "latest":
      return (fn.call(provider, args[0]) as unknown[]).map(tag);
    case "getById":
      return tag(fn.call(provider, args[0]));
    case "getPlaybackGroups":
      return fn.call(provider, args[0]) ?? [];
    case "getPlayerLinks":
      return fn.call(provider, args[0], args[1], args[2]) ?? [];
    case "resolve":
      return fn.call(provider, args[0]) ?? [];
    default:
      return fn.apply(provider, args);
  }
}

scope.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message.kind !== "call") return;
  transport = message.transport;
  try {
    if (transport === "sab") initSab();
    const provider = loadProvider(message.script);
    const value = invoke(provider, message.sourceId, message.method, message.args);
    post({ kind: "result", ok: true, value, bridgeCalls, bridgeMs });
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    post({ kind: "result", ok: false, error: text, bridgeCalls, bridgeMs });
  }
};
