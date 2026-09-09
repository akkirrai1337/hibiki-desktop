// Shared IPC contract types, mirrored from the Android app's Kotlin models
// (hibiki/parsers/.../model/Models.kt) so extension output needs no reshaping
// between main and renderer.

export type AnimeType = "tv" | "ova" | "ona" | "movie" | "special" | string;
export type AnimeStatus = "ongoing" | "released" | "announced" | string;

// A lightweight cross-reference to another title on the *same* source (no sourceId of its own -
// Android's DetailsScreen resolves it against whichever source is currently active, see
// RelatedAnimeTitle in Models.kt). Used for both relatedAnime/franchiseAnime (prequels, sequels,
// side stories - merged into one "related" section, see anime.$sourceId.$animeId.tsx) and
// similarAnime (recommendations).
export interface RelatedAnimeTitle {
  id: string;
  title: string;
  posterUrl?: string | null;
  type?: AnimeType | null;
  year?: number | null;
  episodeCount?: number | null;
  status?: AnimeStatus | null;
}

// One title's rating from one particular ratings site (Shikimori, MAL, Kinopoisk, ...) - a source
// can carry several at once (see toRatings() in e.g. yummy-anime.js), same shape as Android's own
// TitleRating in Models.kt.
export interface TitleRating {
  source: string;
  value: number;
  votes?: number | null;
}

export interface AnimeTitle {
  id: string;
  sourceId: string;
  russianName?: string | null;
  englishName?: string | null;
  originalName?: string | null;
  synonyms?: string[];
  year?: number | null;
  type?: AnimeType | null;
  episodeCount?: number | null;
  availableEpisodeCount?: number | null;
  posterUrl?: string | null;
  status?: AnimeStatus | null;
  description?: string | null;
  nextEpisodeAt?: number | null;
  genres?: string[];
  ratings?: TitleRating[];
  ageRating?: string | null;
  relatedAnime?: RelatedAnimeTitle[];
  franchiseAnime?: RelatedAnimeTitle[];
  similarAnime?: RelatedAnimeTitle[];
}

export interface Episode {
  id: string;
  number: number;
  title?: string | null;
}

export interface PlaybackGroup {
  id: string;
  title: string;
  episodes: Episode[];
  qualityLabel?: string | null;
}

// "DIRECT_DASH" has no Android equivalent in PlayerType (source extensions never return it
// directly) - Android instead carries an internal PlaybackStreamType.DASH assigned only *after*
// a resolver resolves an EMBED link (see PlayerScreen.kt), decoupled from the network-facing
// PlayerLink model. This app reuses PlayerLink end-to-end for both raw and resolved links (see
// runtime.ts's resolveEmbedLinks), so the same distinction is made here instead: "DIRECT_DASH"
// only ever appears on a link a resolver produced (e.g. extractors/aksor.js), never one a source's
// own getPlayerLinks() returns.
export type PlayerLinkType = "DIRECT_HLS" | "DIRECT_MP4" | "DIRECT_DASH" | "EMBED";

// `type`, not `kind` - matches what every source/resolver actually emits (yummy-anime.js,
// kodik.js, ...) and Android's own PlaybackSegment (WatchModels.kt) - confirmed live against a
// real getPlayerLinks() response, where segments come back as {"type":"ENDING",...}.
export interface VideoSegment {
  type: "OPENING" | "ENDING" | "UNKNOWN";
  startMs: number;
  endMs: number;
}

export interface SubtitleTrack {
  url: string;
  label?: string | null;
  language?: string | null;
  headers?: Record<string, string> | null;
}

export interface PlayerLink {
  url: string;
  type: PlayerLinkType;
  quality?: string | null;
  headers?: Record<string, string> | null;
  playerName?: string | null;
  translation?: string | null;
  segments?: VideoSegment[];
  videoId?: string | null;
  audioUrl?: string | null;
  audioHeaders?: Record<string, string> | null;
  subtitles?: SubtitleTrack[];
}

export interface DownloadRequest {
  sourceId: string;
  animeId: string;
  groupId: string;
  episodeId: string;
  episodeNumber: number;
  animeTitle: string;
  episodeLabel: string;
  // Matched exactly against a candidate PlayerLink's own `quality` (see downloads.ts's
  // selectPlayerLink) - unset falls back to the previous "best available" pick.
  quality?: string | null;
}

// A finished download, as listed on the "Downloaded episodes" screen - `animeTitle`/`animePosterUrl`
// come along from cachedAnime (see main/offlineCache.ts) so that screen doesn't need a live,
// per-title round trip to the source just to render a poster grid of stuff already on disk.
export interface DownloadedEpisode {
  sourceId: string;
  animeId: string;
  groupId: string;
  episodeId: string;
  episodeNumber: number;
  episodeLabel: string;
  filePath: string;
  fileSizeBytes: number;
  durationMs: number | null;
  downloadedAt: number;
  animeTitle: string;
  animePosterUrl: string | null;
}

export interface DownloadProgress {
  episodeId: string;
  status: "queued" | "downloading" | "paused" | "done" | "error" | "unsupported" | "cancelled";
  percent?: number;
  filePath?: string;
  message?: string;
}

export type SourceCapability =
  | "LATEST_RELEASES"
  | "PLAYBACK"
  | "RELATED_TITLES"
  | "SIMILAR_TITLES"
  // What a source can do once someone is signed in to it. Each one gates a piece of UI, so a
  // source that declares nothing here looks exactly as it does today.
  | "ACCOUNT"
  | "COMMENTS"
  | "REVIEWS"
  | "LIBRARY_SYNC"
  // Reports watching itself - an episode counted and the minutes actually spent in it - to the
  // account, rather than only what is in a list.
  | "ACTIVITY_SYNC";

/**
 * One row on a source's settings page, as the source itself declares it.
 *
 * The app renders these without knowing which source it is looking at - it understands field
 * types, not source names. "ACCOUNT" is the one that is not a value at all: it stands for the
 * sign-in block, which the app draws itself from the source's login/logout/getAccount methods.
 */
export type SourceSettingType =
  | "ACCOUNT"
  // Like TOGGLE, but the app knows what it means: turning it on is the moment two libraries that
  // already disagree have to be reconciled, and that is a question only the person can answer. A
  // type rather than a well-known key, so the screen still knows nothing about any one source.
  | "LIBRARY_SYNC"
  // Like TOGGLE, and known to the app for the same reason as LIBRARY_SYNC: it decides whether
  // watching is reported at all, which the player has to be able to ask without knowing the
  // source.
  | "ACTIVITY_SYNC"
  | "TOGGLE"
  | "TEXT"
  | "SELECT";

export interface SourceSetting {
  key: string;
  type: SourceSettingType;
  /** The fallback wording, in whatever language the source author wrote it. */
  title: string;
  description?: string | null;
  /**
   * The same two, per language tag, so a source's own rows are not stuck in one language while
   * the app around them is translated. Keyed by the tags the app uses ("ru", "uk", ...); a missing
   * one falls back to `title`/`description` above, which is why those stay required.
   */
  titleI18n?: Record<string, string> | null;
  descriptionI18n?: Record<string, string> | null;
  /** SELECT only. */
  options?: SearchFilterOption[];
  /** TOGGLE and TEXT. Absent means off / empty. */
  default?: boolean | string;
}

/** Who is signed in to a source, as far as the source is concerned. */
export interface SourceAccount {
  id: string;
  name: string;
  avatarUrl?: string | null;
  profileUrl?: string | null;
}

/** One row of a source account's own library, as the source reports it. */
export interface SourceLibraryEntry {
  animeId: string;
  title?: string | null;
  posterUrl?: string | null;
  category: LibraryCategory;
  rating?: number | null;
}

export interface SourceComment {
  id: string;
  authorName: string;
  authorAvatarUrl?: string | null;
  text: string;
  createdAt: number;
  likes?: number;
  replyCount?: number;
  /** Set on replies, so a flat list can still be drawn as threads. */
  parentId?: string | null;
}

export interface SourceReview {
  id: string;
  authorName: string;
  authorAvatarUrl?: string | null;
  text: string;
  createdAt: number;
  rating?: number | null;
  likes?: number;
}

// Mirrors Android's AnimeSearchFilter enum (hibiki/parsers/.../model/Models.kt) - what a source's
// manifest declares it accepts in a search request, gating which filter controls the UI shows.
export type SearchFilterKind = "TYPE" | "STATUS" | "INCLUDED_GENRES" | "EXCLUDED_GENRES" | "YEAR_RANGE";

export interface SourceInfo {
  id: string;
  name: string;
  version: string;
  iconUrl?: string | null;
  lang?: string | null;
  capabilities: SourceCapability[];
  supportedSorts: string[];
  supportedFilters: SearchFilterKind[];
  runtime?: "NODE" | "BROWSER";
  /** Empty for every source that does not declare any - which is all of them until one does. */
  settings: SourceSetting[];
}

// A source-declared (id, display title) pair - options come from the source itself (e.g. its own
// genre list), never hardcoded on the client. Mirrors Android's SearchFilterOption.
export interface SearchFilterOption {
  id: string;
  title: string;
}

// Mirrors Android's AnimeSearchFilterCatalog - what populates the filter panel's controls for one
// source, fetched from the extension's getSettings().
export interface SearchFilterCatalog {
  sortOptions: SearchFilterOption[];
  typeOptions: SearchFilterOption[];
  statusOptions: SearchFilterOption[];
  genreOptions: SearchFilterOption[];
}

// A source not yet installed, as listed by a repository's index.json (see hibiki-sources'
// repository/index.json / extensions/<id>.manifest.json convention). Mirrors the Android app's
// MarketplaceExtension so both clients can talk to the same repositories.
export interface MarketplaceExtension {
  id: string;
  name: string;
  version: string;
  author?: string | null;
  website?: string | null;
  iconUrl?: string | null;
  lang: string;
  capabilities: SourceCapability[];
  resolverDependencies: string[];
  isNsfw: boolean;
  type: string; // "source" | "player-resolver"
  manifestUrl: string;
}

export type RepositoryFetchResult =
  | { url: string; ok: true; extensions: MarketplaceExtension[] }
  | { url: string; ok: false; error: string };

export interface SearchRequest {
  query?: string;
  offset?: number;
  limit?: number;
  sort?: string;
  typeAliases?: string[];
  statusAliases?: string[];
  includedGenreAliases?: string[];
  excludedGenreAliases?: string[];
  yearFrom?: number;
  yearTo?: number;
}

export type LibraryCategory = "watching" | "planned" | "completed" | "dropped" | "on_hold" | "favorite";

export interface LibraryEntry {
  animeId: string;
  sourceId: string;
  category: LibraryCategory;
  addedAt: number;
  anime: AnimeTitle;
}

export interface WatchProgress {
  sourceId: string;
  titleId: string;
  episodeId: string;
  episodeNumber: number;
  // The playback group this episode was watched under - null for progress saved before this field
  // existed. Lets a "continue watching" card build a full `/watch/...` URL (which needs a group)
  // on its own instead of only ever linking to the anime detail page.
  groupId?: string | null;
  quality?: string | null;
  // The dub studio/player this episode was last watched through - preferred over the source's own
  // default link ordering when resuming, so a deliberately-picked dub sticks across episodes.
  translation?: string | null;
  playerName?: string | null;
  positionMs: number;
  durationMs: number;
  watched: boolean;
  updatedAt: number;
  // A JPEG data URL of the video frame at the moment playback last stopped (pause, or leaving the
  // episode) - see VideoPlayer's onCaptureThumbnail. Null until the first capture happens for this
  // episode, and always null for EMBED playback (no <video> element of our own to draw from).
  thumbnailDataUrl?: string | null;
  // How much of this save actually played, measured by the player rather than inferred from how
  // far the position moved. Absent for callers that only move the position (marking an episode
  // watched from a list), which fall back to that distance - see progressUpsert.
  watchedDeltaMs?: number;
}

export interface DailyActivity {
  date: string; // YYYY-MM-DD, local time
  watchedMs: number;
  completedCount: number;
}

// One achievement tier cleared - see achievements.ts's tiersClearedInRange for how `kind` (a tier
// id, e.g. "collector_10") maps back to an icon/title for display.
export interface XpEvent {
  id: number;
  kind: string;
  xp: number;
  createdAt: number;
}

// Mirrors the fields Android's DiscordRpcManager.DiscordPlaybackPresence puts on the Rich Presence
// card (title as `details`, dub as `state`, timeline via timestamps) - see discordRpc.ts for why
// the desktop transport (local IPC to the Discord client) can't carry a per-title cover image the
// way Android's gateway-based one does.
export interface DiscordPresence {
  animeTitle: string;
  translation: string | null;
  episodeNumber: number | null;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  posterUrl: string | null;
}

/** A GitHub release newer than the running build - see main/appUpdates.ts. */
export interface AppUpdate {
  /** Without the leading "v" of the tag. */
  version: string;
  releaseUrl: string;
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
  notes: string;
  publishedAt: string | null;
}

export interface UpdateDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
}

/**
 * Everything installed, read in one go.
 *
 * One snapshot rather than two queries because these two halves together answer a single question
 * - "does this source have an update" - and asking for them separately let them drift: the
 * resolver half was read once at app start and never refreshed, so a source stayed marked as
 * updatable forever after its update had actually applied.
 */
export interface InstalledVersions {
  /** Source id -> installed version. */
  sources: Record<string, string>;
  /** Player-resolver id -> installed version. Resolvers never appear in the sources list. */
  resolvers: Record<string, string>;
}

/** A title read back out of the on-disk cache, with when it was last written. */
export interface CachedAnimeEntry {
  title: AnimeTitle;
  cachedAt: number;
}
