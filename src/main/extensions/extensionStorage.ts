// Per-source persistent storage for extension scripts.
//
// Extensions had nowhere to keep anything between calls, which is fine for a catalog and useless
// for an account: a login is worth nothing if the token dies with the worker that fetched it. This
// gives each source its own small key/value store, owned by the host rather than by the script -
// the script asks for a value by name and never learns where it lives, which is what lets the
// value be encrypted here without every extension having to care.
//
// Values are handed to a call as a plain snapshot and any writes come back with the result (see
// execute.ts), so scripts keep the synchronous, Rhino-shaped API they were written against and
// nothing needs a second bridge across the worker boundary.
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { logger } from "../logger";

/** Marks the encrypted form on disk, so a store written before encryption was available (or on a
 * machine where it never is) still reads back rather than being mistaken for ciphertext. */
const ENCRYPTED_PREFIX = "enc:v1:";

export class ExtensionStorage {
  private readonly cache = new Map<string, Record<string, string>>();

  constructor(private readonly storageDir: string) {}

  private fileFor(sourceId: string): string {
    // Source ids come from manifests, which the user can install from any repository - a traversal
    // in one would otherwise let a source write outside its own store.
    const safeId = sourceId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.storageDir, `${safeId}.json`);
  }

  read(sourceId: string): Record<string, string> {
    const cached = this.cache.get(sourceId);
    if (cached) return { ...cached };

    const file = this.fileFor(sourceId);
    let values: Record<string, string> = {};
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, "utf-8");
        const decoded = raw.startsWith(ENCRYPTED_PREFIX) ? this.decrypt(raw.slice(ENCRYPTED_PREFIX.length)) : raw;
        const parsed = JSON.parse(decoded) as unknown;
        if (parsed && typeof parsed === "object") values = parsed as Record<string, string>;
      } catch (error) {
        // A corrupt or undecryptable store is not worth failing a source over: it means the user
        // signs in again, not that the catalog stops working.
        logger.warn("ext", `storage for '${sourceId}' unreadable, starting empty: ${String(error)}`);
      }
    }
    this.cache.set(sourceId, values);
    return { ...values };
  }

  /** Applies the writes a call made. `null` removes a key; keys not mentioned are left alone. */
  apply(sourceId: string, writes: Record<string, string | null>): void {
    if (Object.keys(writes).length === 0) return;
    const values = this.read(sourceId);
    for (const [key, value] of Object.entries(writes)) {
      if (value === null) delete values[key];
      else values[key] = value;
    }
    this.cache.set(sourceId, values);
    this.write(sourceId, values);
  }

  clear(sourceId: string): void {
    this.cache.delete(sourceId);
    const file = this.fileFor(sourceId);
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  private write(sourceId: string, values: Record<string, string>): void {
    fs.mkdirSync(this.storageDir, { recursive: true });
    const json = JSON.stringify(values);
    let payload = json;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        payload = ENCRYPTED_PREFIX + safeStorage.encryptString(json).toString("base64");
      }
    } catch (error) {
      // Plain text beats losing the value; on Linux this depends on a keyring being present at
      // all, and a missing one must not turn signing in into an error the user cannot act on.
      logger.warn("ext", `storage for '${sourceId}' saved unencrypted: ${String(error)}`);
    }
    fs.writeFileSync(this.fileFor(sourceId), payload, "utf-8");
  }

  private decrypt(base64: string): string {
    return safeStorage.decryptString(Buffer.from(base64, "base64"));
  }
}
