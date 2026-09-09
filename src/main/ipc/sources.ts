import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import type { AnimeTitle, PlaybackGroup, PlayerLink } from "@shared/types";
import type { ExtensionRuntime } from "../extensions/runtime";
import { cacheAnime, getCachedAnime, getCachedAnimeMany, getCachedPlaybackGroups } from "../offlineCache";

export function registerSourceHandlers(runtime: ExtensionRuntime): void {
  ipcMain.handle(IPC.sourcesList, () => runtime.list());
  ipcMain.handle(IPC.sourceSearch, (_e, sourceId: string, request) => runtime.search(sourceId, request));
  ipcMain.handle(IPC.sourceLatest, (_e, sourceId: string, limit: number) => runtime.latest(sourceId, limit));
  // Falls back to whatever's cached (either from a previous successful fetch below, or from one of
  // this title's episodes finishing a download - see downloads.ts's cacheForOffline) - the source
  // itself being unreachable (offline, taken down, extension uninstalled, ...) shouldn't also take
  // down the title page, or a continue-watching/library card, for a title seen before. A title with
  // nothing cached still fails exactly as before.
  ipcMain.handle(IPC.sourceGetById, async (_e, sourceId: string, id: string): Promise<AnimeTitle> => {
    try {
      const anime = await runtime.getById(sourceId, id);
      cacheAnime(sourceId, id, anime);
      return anime;
    } catch (err) {
      const cached = getCachedAnime(sourceId, id);
      if (cached) return cached;
      throw err;
    }
  });
  // Synchronous on purpose - it is a single indexed SQLite read per title, and making the
  // renderer wait a microtask for it would defeat the point of having it.
  ipcMain.handle(IPC.sourceCachedTitles, (_e, keys: Array<{ sourceId: string; animeId: string }>) =>
    getCachedAnimeMany(keys),
  );
  ipcMain.handle(IPC.sourcePlaybackGroups, async (_e, sourceId: string, titleId: string): Promise<PlaybackGroup[]> => {
    try {
      return await runtime.getPlaybackGroups(sourceId, titleId);
    } catch (err) {
      const cached = getCachedPlaybackGroups(sourceId, titleId);
      if (cached) return cached;
      throw err;
    }
  });
  ipcMain.handle(
    IPC.sourcePlayerLinks,
    (_e, sourceId: string, titleId: string, groupId: string, episodeId: string) =>
      runtime.getPlayerLinks(sourceId, titleId, groupId, episodeId),
  );
  ipcMain.handle(IPC.sourceResolvePlayerLink, (_e, link: PlayerLink) => runtime.resolvePlayerLink(link));
  ipcMain.handle(IPC.sourceFilterCatalog, (_e, sourceId: string) => runtime.getFilterCatalog(sourceId));

  // Straight through to the source. The password is a parameter of this one call and is written
  // nowhere: whatever the source needs in order to prove itself again later, it puts in its own
  // store (see extensionStorage.ts), and the host never learns what that is.
  ipcMain.handle(IPC.sourceLogin, (_e, sourceId: string, credentials: { login: string; password: string }) =>
    runtime.login(sourceId, credentials),
  );
  ipcMain.handle(IPC.sourceLogout, (_e, sourceId: string) => runtime.logout(sourceId));
  ipcMain.handle(IPC.sourceAccount, (_e, sourceId: string) => runtime.getAccount(sourceId));
  ipcMain.handle(IPC.sourceComments, (_e, sourceId: string, request: Parameters<typeof runtime.listComments>[1]) =>
    runtime.listComments(sourceId, request),
  );
  ipcMain.handle(IPC.sourcePostComment, (_e, sourceId: string, request: Parameters<typeof runtime.postComment>[1]) =>
    runtime.postComment(sourceId, request),
  );
  ipcMain.handle(IPC.sourceReviews, (_e, sourceId: string, request: Parameters<typeof runtime.listReviews>[1]) =>
    runtime.listReviews(sourceId, request),
  );
  ipcMain.handle(IPC.sourcePostReview, (_e, sourceId: string, request: Parameters<typeof runtime.postReview>[1]) =>
    runtime.postReview(sourceId, request),
  );
  ipcMain.handle(IPC.sourceSettingsRead, (_e, sourceId: string) => runtime.readSettings(sourceId));
  ipcMain.handle(IPC.sourceSettingsWrite, (_e, sourceId: string, key: string, value: string | null) =>
    runtime.writeSetting(sourceId, key, value),
  );
  ipcMain.handle(
    IPC.sourceSyncLibraryEntry,
    (_e, sourceId: string, request: Parameters<typeof runtime.syncLibraryEntry>[1]) =>
      runtime.syncLibraryEntry(sourceId, request),
  );
}
