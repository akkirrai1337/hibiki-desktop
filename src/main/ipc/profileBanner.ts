import fs from "node:fs/promises";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC } from "@shared/ipc";

// A profile banner (an image, GIF, or short video the user picks for their own profile page) is
// only ever cosmetic and local, but can be several MB - too big to keep as a `data:` URL in
// localStorage the way the avatar is (see profileStore.ts). Written once to a small dedicated
// folder instead, with only its filename (not its bytes) round-tripping through the persisted
// store. Old files are deleted eagerly on replace/clear rather than left to pile up, since there
// is never more than one banner.
export const PROFILE_DIR = path.join(app.getPath("userData"), "profile");

// Whatever the picker offers (see AvatarPicker's sibling, BannerPicker, in pages/profile.tsx): a
// still image, an animated GIF, or a short video.
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/gif": "gif",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

async function clearExisting(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROFILE_DIR);
  } catch {
    return;
  }
  await Promise.all(entries.filter((name) => name.startsWith("banner.")).map((name) => fs.rm(path.join(PROFILE_DIR, name), { force: true })));
}

export function registerProfileBannerHandlers(): void {
  ipcMain.handle(IPC.profileSetBanner, async (_e, bytes: ArrayBuffer, mimeType: string) => {
    const extension = EXTENSION_BY_MIME[mimeType];
    if (!extension) throw new Error(`Unsupported banner type: ${mimeType}`);
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    await clearExisting();
    const filename = `banner.${extension}`;
    await fs.writeFile(path.join(PROFILE_DIR, filename), Buffer.from(bytes));
    return filename;
  });

  ipcMain.handle(IPC.profileClearBanner, async () => {
    await clearExisting();
  });
}
