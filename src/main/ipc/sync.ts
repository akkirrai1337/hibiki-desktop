import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import type { SyncCandidate } from "@shared/types";
import { createSyncServerApi } from "../../core/api/sync";
import { startSyncServer } from "../sync";

/** The computer's side of device sync: the listening sockets and the pairing window. */
export function registerSyncHandlers(): void {
  const sync = createSyncServerApi();
  ipcMain.handle(IPC.syncDevices, () => sync.devices());
  ipcMain.handle(IPC.syncRemove, (_e, deviceId: string) => sync.remove(deviceId));
  ipcMain.handle(IPC.syncStartPairing, () => sync.startPairing!());
  ipcMain.handle(IPC.syncStopPairing, () => sync.stopPairing!());
  ipcMain.handle(IPC.syncDiscover, () => sync.discover!());
  ipcMain.handle(IPC.syncPair, (_e, candidate: SyncCandidate, code: string) => sync.pair!(candidate, code));
  ipcMain.handle(IPC.syncNow, () => sync.syncNow!());
  startSyncServer();
  // Computers this one reaches out to: at start and every few minutes (the phone does the same).
  const quietly = () => void sync.syncNow!().catch(() => undefined);
  setTimeout(quietly, 5_000);
  setInterval(quietly, 3 * 60 * 1000);
}
