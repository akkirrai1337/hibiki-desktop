// Device sync, the wire: what travels between a phone and a computer on the same network.
//
// A computer listens all the time; a phone listens while the app is on screen (Android would not keep
// it reachable in the background). Either can connect to one that listens. One connection
// carries one request and its answer, each a JSON message framed by a 4-byte big-endian length.
// Finding the computer is a UDP broadcast the computer answers.
import type { ChangeSet } from "./changes";
import type { Sealed } from "./crypto";

export const SYNC_PORT = 47652;
export const DISCOVERY_PORT = 47653;
export const DISCOVERY_PROBE = "hibiki-sync-discover v1";
export const PROTOCOL_VERSION = 1;

/** What a computer answers a discovery probe with. */
export interface DiscoveryAnswer {
  app: "hibiki";
  v: number;
  deviceId: string;
  name: string;
  port: number;
  kind: "computer" | "phone";
}

export type SyncRequest =
  | { v: number; type: "pair-hello"; from: string; name: string; pub: string }
  | { v: number; type: "pair-confirm"; from: string; proof: string }
  | { v: number; type: "sync"; from: string; sealed: Sealed };

export type SyncErrorCode = "not-pairing" | "too-many-attempts" | "bad-code" | "unknown-device" | "bad-message" | "version";

export type SyncResponse =
  | { ok: false; error: SyncErrorCode }
  | { ok: true; type: "pair-hello"; from: string; name: string; pub: string; proof: string }
  | { ok: true; type: "pair-confirm" }
  | { ok: true; type: "sync"; sealed: Sealed };

/** Inside a sealed sync request: the phone's changes, and from where it wants the computer's. */
export interface SyncPayload {
  want: number;
  changes: ChangeSet;
}

/** Inside a sealed sync answer. */
export interface SyncAnswer {
  changes: ChangeSet;
}

/** 4-byte big-endian length, then the UTF-8 JSON. */
export function frame(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/** Messages larger than this are refused - a batch is far smaller (see changes.ts). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
