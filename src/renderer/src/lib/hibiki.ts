import type {
  AnimeTitle,
  DailyActivity,
  DiscordPresence,
  DownloadedEpisode,
  DownloadProgress,
  DownloadRequest,
  LibraryEntry,
  MarketplaceExtension,
  PlaybackGroup,
  PlayerLink,
  RepositoryFetchResult,
  SearchFilterCatalog,
  SearchRequest,
  SourceInfo,
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
    search(sourceId: string, request: SearchRequest): Promise<AnimeTitle[]>;
    latest(sourceId: string, limit: number): Promise<AnimeTitle[]>;
    getById(sourceId: string, id: string): Promise<AnimeTitle>;
    playbackGroups(sourceId: string, titleId: string): Promise<PlaybackGroup[]>;
    playerLinks(sourceId: string, titleId: string, groupId: string, episodeId: string): Promise<PlayerLink[]>;
    resolvePlayerLink(link: PlayerLink): Promise<PlayerLink[]>;
    filterCatalog(sourceId: string): Promise<SearchFilterCatalog>;
    repositories: {
      list(): Promise<string[]>;
      add(url: string): Promise<string[]>;
      remove(url: string): Promise<string[]>;
    };
    marketplace(urls: string[]): Promise<RepositoryFetchResult[]>;
    install(extension: MarketplaceExtension, originUrl: string): Promise<SourceInfo[]>;
    uninstall(id: string): Promise<SourceInfo[]>;
    resolverVersions(): Promise<Record<string, string>>;
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

// Builds a src the player can actually load for a downloaded file - see main/index.ts's
// `hibiki-download` protocol handler for why this can't just be a plain `file://` path (blocked
// as cross-origin from the renderer's own origin in dev, where it's served over http). The whole
// absolute path travels as one url-encoded opaque segment, not real path segments, so it
// round-trips exactly regardless of platform-specific separators/drive letters.
export function downloadFileUrl(filePath: string): string {
  return `hibiki-download://local/${encodeURIComponent(filePath)}`;
}
