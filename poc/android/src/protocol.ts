// Messages between the main thread (extensionHost.ts) and an extension worker (extWorker.ts).
//
// Two transports for the worker's *synchronous* host calls are under test (plan, phase 0.1/0.2):
//  - "sab": the desktop pattern - Atomics.wait on a SharedArrayBuffer flag, reply written into a
//    second (growable) SharedArrayBuffer. Needs crossOriginIsolated.
//  - "xhr": fallback - the worker blocks in a synchronous XHR to https://localhost/_hibiki/bridge/<id>,
//    which native code holds open until the main thread hands it the reply via HibikiNet.bridgeResolve.
export type Transport = "sab" | "xhr";
export type BridgeKind = "netFetch" | "netFetchAll" | "challenge" | "browserFetch";

export type WorkerInbound = {
  kind: "call";
  sourceId: string;
  script: string;
  method: string;
  args: unknown[];
  transport: Transport;
};

export type WorkerOutbound =
  | { kind: "init"; ctrl: SharedArrayBuffer; data: SharedArrayBuffer }
  | { kind: "bridge"; id: string; bridgeKind: BridgeKind; payload: Record<string, unknown> }
  | { kind: "log"; level: "log" | "warn" | "error"; message: string }
  | { kind: "result"; ok: true; value: unknown; bridgeCalls: number; bridgeMs: number }
  | { kind: "result"; ok: false; error: string; bridgeCalls: number; bridgeMs: number };

export type BridgeReply = { ok: true; value: unknown } | { ok: false; error: string };
