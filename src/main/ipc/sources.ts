import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import type { AnimeTitle, ExternalMetadataPreferences, MetadataBindingState, PlaybackGroup, PlayerLink, PlayerLinkPreference } from "@shared/types";
import { mergeExternalMetadata, type MetadataProviderId } from "@shared/externalMetadata";
import type { ExtensionRuntime } from "../extensions/runtime";
import {
  clearMatch,
  currentMatch,
  describeMany,
  fetchEntry,
  getExternalMetadata,
  searchProviders,
  setManualMatch,
} from "../metadata/externalMetadataService";
import { providerOrderFor, setExternalMetadataPreferences } from "../metadata/metadataPreferences";
import { cacheAnime, cachePlaybackGroups, cacheSourceQuery, getCachedAnime, getCachedAnimeMany, getCachedPlaybackGroups, getCachedPlaybackGroupsEntry, getCachedSourceQuery } from "../offlineCache";

export function registerSourceHandlers(runtime: ExtensionRuntime): void {
  // Which providers may describe this source's titles, in order - shared by every path below, so a
  // list, a title page and the line naming the provider all agree.
  const orderFor = (sourceId: string): MetadataProviderId[] =>
    providerOrderFor(sourceId, runtime.list().find((info) => info.id === sourceId)?.useExternalMetadata === true);

  /**
   * Replaces a title's descriptive fields with a metadata provider's, when both the source asked
   * for that in its manifest and the user has not turned it off.
   *
   * Failures are swallowed on purpose: a provider being unreachable, rate-limiting us, or simply
   * not carrying this title must cost the better description and nothing else - the source's own
   * page still renders exactly as it did before this existed.
   */
  const describe = async (sourceId: string, anime: AnimeTitle): Promise<AnimeTitle> => {
    const order = orderFor(sourceId);
    if (order.length === 0) return anime;
    try {
      return mergeExternalMetadata(anime, await getExternalMetadata(anime, order));
    } catch {
      return anime;
    }
  };

  // Lists are deliberately *not* described from a provider, not even from the cache. Enriching only
  // the titles that happen to be cached leaves a screen where some cards are named by the provider
  // and some by the source, and the two disagree - which reads as a broken list even when every
  // entry in it is correct. Describing all of them instead would mean a match per unseen title, at
  // roughly one request a second, on a screen built to be scrolled. So a card shows what its source
  // called the title, and the provider's version starts at the title page.
  ipcMain.handle(IPC.metadataSetPreferences, (_e, preferences: ExternalMetadataPreferences) =>
    setExternalMetadataPreferences(preferences),
  );
  ipcMain.handle(IPC.metadataMatch, (_e, sourceId: string, animeId: string): MetadataBindingState => {
    const providers = orderFor(sourceId);
    return { providers, match: currentMatch(sourceId, animeId, providers) };
  });
  ipcMain.handle(IPC.metadataDescribeList, async (_e, sourceId: string, titles: AnimeTitle[]): Promise<AnimeTitle[]> => {
    const order = orderFor(sourceId);
    if (order.length === 0 || titles.length === 0) return titles;
    try {
      const described = new Map((await describeMany(titles, order)).map((entry) => [entry.animeId, entry.media]));
      return titles.map((title) => mergeExternalMetadata(title, described.get(title.id) ?? null));
    } catch {
      return titles;
    }
  });
  ipcMain.handle(IPC.metadataSearch, (_e, sourceId: string, query: string) =>
    searchProviders(query, orderFor(sourceId)),
  );
  ipcMain.handle(IPC.metadataEntry, (_e, provider: MetadataProviderId, reference: { externalId?: number; slug?: string }) =>
    fetchEntry(provider, reference),
  );
  ipcMain.handle(
    IPC.metadataSetMatch,
    (_e, sourceId: string, animeId: string, provider: MetadataProviderId, externalId: number) =>
      setManualMatch(sourceId, animeId, provider, externalId),
  );
  ipcMain.handle(IPC.metadataClearMatch, (_e, sourceId: string, animeId: string) => clearMatch(sourceId, animeId));
  ipcMain.handle(IPC.sourcesList, () => runtime.list());
  ipcMain.handle(IPC.sourceSearch, (_e, sourceId: string, request, requestId?: string) => runtime.search(sourceId, request, requestId));
  ipcMain.on(IPC.sourceSearchCancel, (_e, requestId: string) => runtime.cancelRequest(requestId));
  ipcMain.handle(IPC.sourceLatest, (_e, sourceId: string, limit: number) => runtime.latest(sourceId, limit));
  // Falls back to whatever's cached (either from a previous successful fetch below, or from one of
  // this title's episodes finishing a download - see downloads.ts's cacheForOffline) - the source
  // itself being unreachable (offline, taken down, extension uninstalled, ...) shouldn't also take
  // down the title page, or a continue-watching/library card, for a title seen before. A title with
  // nothing cached still fails exactly as before.
  ipcMain.handle(IPC.sourceGetById, async (_e, sourceId: string, id: string): Promise<AnimeTitle> => {
    try {
      const anime = await describe(sourceId, await runtime.getById(sourceId, id));
      // Cached *after* the merge, so an offline visit shows the same page the online one did
      // rather than falling back to the source's own thinner description.
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
  ipcMain.handle(IPC.sourceCachedPlaybackGroups, (_e, sourceId: string, titleId: string) =>
    getCachedPlaybackGroupsEntry(sourceId, titleId),
  );
  ipcMain.handle(IPC.sourceCachedQuery, (_e, queryKey: string) => getCachedSourceQuery(queryKey));
  // `on`, not `handle`: the renderer has already rendered these titles, and nothing it does next
  // depends on the write landing.
  ipcMain.on(IPC.sourceCacheQuery, (_e, queryKey: string, titles: AnimeTitle[]) => {
    try {
      cacheSourceQuery(queryKey, titles);
    } catch {
      // A first paint that is one round trip slower next launch, and nothing worse.
    }
  });
  ipcMain.handle(IPC.sourcePlaybackGroups, async (_e, sourceId: string, titleId: string): Promise<PlaybackGroup[]> => {
    try {
      const groups = await runtime.getPlaybackGroups(sourceId, titleId);
      cachePlaybackGroups(sourceId, titleId, groups);
      return groups;
    } catch (err) {
      const cached = getCachedPlaybackGroups(sourceId, titleId);
      if (cached) return cached;
      throw err;
    }
  });
  ipcMain.handle(
    IPC.sourcePlayerLinks,
    (_e, sourceId: string, titleId: string, groupId: string, episodeId: string, preference?: PlayerLinkPreference) =>
      runtime.getPlayerLinks(sourceId, titleId, groupId, episodeId, preference),
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
  ipcMain.handle(
    IPC.sourceReportPlayback,
    (_e, sourceId: string, request: Parameters<typeof runtime.reportPlayback>[1]) => {
      // Silently skipped rather than refused when the switch is off: the player calls this on
      // every save and has no business knowing which sources report anything.
      if (!runtime.isActivitySyncEnabled(sourceId)) return false;
      return runtime.reportPlayback(sourceId, request);
    },
  );
  ipcMain.handle(IPC.sourcePingOnline, (_e, sourceId: string) => {
    if (!runtime.isActivitySyncEnabled(sourceId)) return false;
    return runtime.pingOnline(sourceId);
  });
  ipcMain.handle(IPC.sourceListLibrary, (_e, sourceId: string) => runtime.listLibrary(sourceId));
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
