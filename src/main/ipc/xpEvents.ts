import { ipcMain } from "electron";
import { desc } from "drizzle-orm";
import { IPC } from "@shared/ipc";
import type { XpEvent } from "@shared/types";
import { getDb } from "../db";
import { xpEvents } from "../db/schema";

// Recent-first, capped - a running history is meant to be skimmed, not paginated through.
const HISTORY_LIMIT = 100;

export function registerXpEventHandlers(): void {
  ipcMain.handle(IPC.xpEventsList, (): XpEvent[] =>
    getDb().select().from(xpEvents).orderBy(desc(xpEvents.id)).limit(HISTORY_LIMIT).all(),
  );

  ipcMain.handle(IPC.xpEventsRecord, (_e, kind: string, xp: number, createdAt: number) => {
    getDb().insert(xpEvents).values({ kind, xp, createdAt }).run();
  });
}
