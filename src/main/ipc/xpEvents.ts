import { ipcMain } from "electron";
import { desc } from "drizzle-orm";
import { IPC } from "@shared/ipc";
import type { XpEvent } from "@shared/types";
import { getDb } from "../db";
import { xpEvents } from "../../core/db/schema";

// Recent-first, capped - a running history is meant to be skimmed, not paginated through.
const HISTORY_LIMIT = 100;

export function registerXpEventHandlers(): void {
  ipcMain.handle(IPC.xpEventsList, async (): Promise<XpEvent[]> =>
    await getDb().select().from(xpEvents).orderBy(desc(xpEvents.id)).limit(HISTORY_LIMIT).all(),
  );

  ipcMain.handle(IPC.xpEventsRecord, async (_e, kind: string, xp: number, createdAt: number) => {
    await getDb().insert(xpEvents).values({ kind, xp, createdAt }).run();
  });

  // Only ever clears this log - achievement/level progress is derived from watch time and
  // unlocked tiers (see levelProgress.ts), not from these rows, so this can't accidentally take
  // XP or levels away, just the record of how they were earned.
  ipcMain.handle(IPC.xpEventsClear, async () => {
    await getDb().delete(xpEvents).run();
  });
}
