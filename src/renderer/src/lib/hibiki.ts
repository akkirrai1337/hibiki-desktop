import type { ExternalCatalogRequest, ExternalMetadata, MetadataProviderId } from "@shared/externalMetadata";
import type {
  AnimeTitle,
  AppUpdate,
  CachedAnimeEntry,
  CachedPlaybackGroupsEntry,
  CachedTitleListEntry,
  DailyActivity,
  DiscordPresence,
  DownloadedEpisode,
  DownloadProgress,
  DownloadRequest,
  ExternalMetadataPreferences,
  InstalledVersions,
  MetadataBindingState,
  RatingSyncResult,
  MetadataSearchResult,
  ResolvedSourceTitle,
  LibraryEntry,
  MarketplaceExtension,
  PlaybackGroup,
  PlayerLink,
  PlayerLinkPreference,
  RepositoryFetchResult,
  SearchFilterCatalog,
  SearchRequest,
  SourceAccount,
  SourceComment,
  SourceInfo,
  SourceLibraryEntry,
  SourceReview,
  UpdateDownloadProgress,
  WatchProgress,
  XpEvent,
} from "@shared/types";

export interface LogEntry {
  time: number;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
}

export interface HibikiApi {
  sources: {
    list(): Promise<SourceInfo[]>;
    search(sourceId: string, request: SearchRequest, requestId?: string): Promise<AnimeTitle[]>;
    cancelSearch(requestId: string): void;
    latest(sourceId: string, limit: number): Promise<AnimeTitle[]>;
    getById(sourceId: string, id: string): Promise<AnimeTitle>;
    cachedTitles(keys: Array<{ sourceId: string; animeId: string }>): Promise<Record<string, CachedAnimeEntry>>;
    cachedPlaybackGroups(sourceId: string, titleId: string): Promise<CachedPlaybackGroupsEntry | null>;
    cachedQuery(queryKey: string): Promise<CachedTitleListEntry | null>;
    cacheQuery(queryKey: string, titles: AnimeTitle[]): void;
    playbackGroups(sourceId: string, titleId: string): Promise<PlaybackGroup[]>;
    playerLinks(sourceId: string, titleId: string, groupId: string, episodeId: string, preference?: PlayerLinkPreference): Promise<PlayerLink[]>;
    resolvePlayerLink(link: PlayerLink): Promise<PlayerLink[]>;
    filterCatalog(sourceId: string): Promise<SearchFilterCatalog>;
    // Account, and what an account unlocks. Answered only by sources declaring the matching
    // capability - see SourceCapability.
    account: {
      get(sourceId: string): Promise<SourceAccount | null>;
      login(sourceId: string, credentials: { login: string; password: string }): Promise<SourceAccount>;
      logout(sourceId: string): Promise<void>;
    };
    comments: {
      list(sourceId: string, request: { animeId: string; parentId?: string | null; offset?: number }): Promise<SourceComment[]>;
      post(sourceId: string, request: { animeId: string; text: string; parentId?: string | null }): Promise<SourceComment>;
      /** 1 to like, -1 to dislike, 0 to take a vote back. */
      vote(sourceId: string, request: { commentId: string; vote: number }): Promise<boolean>;
    };
    reviews: {
      list(sourceId: string, request: { animeId: string; offset?: number }): Promise<SourceReview[]>;
      post(sourceId: string, request: { animeId: string; text: string; rating?: number | null }): Promise<SourceReview>;
    };
    // Values for the rows a source's manifest declares - the same store its script reads, so a
    // toggle flipped here is a value the source can act on. Declared keys only: a session token
    // lives in that store too, and this is not a way to read it.
    settings: {
      read(sourceId: string): Promise<Record<string, string>>;
      write(sourceId: string, key: string, value: string | null): Promise<void>;
    };
    listLibrary(sourceId: string): Promise<SourceLibraryEntry[]>;
    reportPlayback(sourceId: string, request: { videoId: string; positionSeconds: number; durationSeconds: number; watchedSeconds: number[] }): Promise<boolean>;
    pingOnline(sourceId: string): Promise<boolean>;
    syncLibraryEntry(sourceId: string, request: { animeId: string; category: string | null; rating?: number | null }): Promise<void>;
    repositories: {
      list(): Promise<string[]>;
      add(url: string): Promise<string[]>;
      remove(url: string): Promise<string[]>;
    };
    marketplace(urls: string[]): Promise<RepositoryFetchResult[]>;
    install(extension: MarketplaceExtension, originUrl: string): Promise<SourceInfo[]>;
    uninstall(id: string): Promise<SourceInfo[]>;
    installedVersions(): Promise<InstalledVersions>;
    onChanged(callback: () => void): () => void;
  };
  ratings: {
    get(sourceId: string, animeId: string): Promise<number | null>;
    set(sourceId: string, animeId: string, rating: number | null): Promise<RatingSyncResult>;
  };
  library: {
    list(): Promise<LibraryEntry[]>;
    upsert(entry: LibraryEntry): Promise<void>;
    remove(sourceId: string, animeId: string): Promise<void>;
  };
  progress: {
    get(sourceId: string, titleId: string, episodeId: string): Promise<WatchProgress | null>;
    upsert(progress: WatchProgress): Promise<void>;
    listRecent(limit: number): Promise<WatchProgress[]>;
    listForAnime(sourceId: string, titleId: string): Promise<WatchProgress[]>;
    listDailyActivity(days: number): Promise<DailyActivity[]>;
    removeForAnime(sourceId: string, titleId: string): Promise<void>;
    removeEpisode(sourceId: string, titleId: string, episodeId: string): Promise<void>;
    saveThumbnail(sourceId: string, titleId: string, episodeId: string, dataUrl: string): Promise<void>;
  };
  player: {
    registerHeaders(url: string, headers: Record<string, string> | null | undefined): Promise<string>;
    unregisterHeaders(sessionId: string): Promise<void>;
    resolveStreamUrl(url: string, headers: Record<string, string> | null | undefined): Promise<string>;
    captureFrame(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  };
  metadata: {
    setPreferences(preferences: ExternalMetadataPreferences): Promise<void>;
    match(sourceId: string, animeId: string): Promise<MetadataBindingState>;
    describeList(sourceId: string, titles: AnimeTitle[]): Promise<AnimeTitle[]>;
    search(sourceId: string, query: string): Promise<MetadataSearchResult>;
    entry(provider: MetadataProviderId, reference: { externalId?: number; slug?: string }): Promise<ExternalMetadata | null>;
    setMatch(sourceId: string, animeId: string, provider: MetadataProviderId, externalId: number): Promise<ExternalMetadata | null>;
    browse(sourceId: string, request: ExternalCatalogRequest): Promise<{ results: ExternalMetadata[]; provider: MetadataProviderId | null }>;
    resolveSource(sourceId: string, entry: ExternalMetadata): Promise<ResolvedSourceTitle | null>;
    setSourceTitle(sourceId: string, animeId: string, entry: ExternalMetadata): Promise<void>;
    clearMatch(sourceId: string, animeId: string): Promise<void>;
  };
  discord: {
    setEnabled(enabled: boolean): Promise<void>;
    updatePresence(presence: DiscordPresence): Promise<void>;
    setIdlePresence(): Promise<void>;
    clearPresence(): Promise<void>;
  };
  window: {
    unmaximizeForDrag(cursorX: number): void;
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(callback: (maximized: boolean) => void): () => void;
  };
  updates: {
    check(): Promise<AppUpdate | null>;
    downloadAndInstall(update: AppUpdate): Promise<void>;
    openRelease(url: string): Promise<void>;
    onProgress(callback: (progress: UpdateDownloadProgress) => void): () => void;
  };
  zoom: {
    set(factor: number): void;
    get(): number;
  };
  platform: NodeJS.Platform;
  app: {
    getVersion(): Promise<string>;
    relaunch(): void;
  };
  logs: {
    /** Resolves the written path, or null if the save dialog was cancelled. */
    export(): Promise<string | null>;
    recent(limit?: number): Promise<LogEntry[]>;
    openFolder(): void;
    append(level: LogEntry["level"], scope: string, message: string): void;
  };
  backup: {
    create(localStorageEntries: Record<string, string>): Promise<string | null>;
    restore(): Promise<{ localStorage: Record<string, string> } | null>;
  };
  xp: {
    list(): Promise<XpEvent[]>;
    record(kind: string, xp: number, createdAt: number): Promise<void>;
  };
  downloads: {
    start(request: DownloadRequest): Promise<void>;
    pause(episodeId: string): Promise<void>;
    resume(episodeId: string): Promise<void>;
    cancel(episodeId: string): Promise<void>;
    list(): Promise<DownloadedEpisode[]>;
    remove(sourceId: string, animeId: string, episodeId: string): Promise<void>;
    getForEpisode(sourceId: string, animeId: string, episodeId: string): Promise<{ filePath: string; durationMs: number | null; quality: string | null } | null>;
    onProgress(callback: (progress: DownloadProgress) => void): () => void;
  };
}

declare global {
  interface Window {
    hibiki: HibikiApi;
  }
}

export const hibiki = window.hibiki;

/** Lets React Query's AbortSignal terminate the actual extension worker, not merely ignore its
 * eventual answer in the renderer. Used for live search where a newer query supersedes the old. */
export function searchSource(sourceId: string, request: SearchRequest, signal?: AbortSignal): Promise<AnimeTitle[]> {
  if (!signal) return hibiki.sources.search(sourceId, request);
  if (signal.aborted) return Promise.reject(new DOMException("Search cancelled", "AbortError"));

  const requestId = crypto.randomUUID();
  const pending = hibiki.sources.search(sourceId, request, requestId);
  return new Promise<AnimeTitle[]>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      hibiki.sources.cancelSearch(requestId);
      reject(new DOMException("Search cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Builds a src the player can actually load for a downloaded file - see main/index.ts's
// `hibiki-download` protocol handler for why this can't just be a plain `file://` path (blocked
// as cross-origin from the renderer's own origin in dev, where it's served over http). The whole
// absolute path travels as one url-encoded opaque segment, not real path segments, so it
// round-trips exactly regardless of platform-specific separators/drive letters.
export function downloadFileUrl(filePath: string): string {
  return `hibiki-download://local/${encodeURIComponent(filePath)}`;
}
