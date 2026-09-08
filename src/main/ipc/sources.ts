import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import type { AnimeTitle, PlaybackGroup, PlayerLink } from "@shared/types";
import type { ExtensionRuntime } from "../extensions/runtime";
import { cacheAnime, getCachedAnime, getCachedPlaybackGroups } from "../offlineCache";

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
}
