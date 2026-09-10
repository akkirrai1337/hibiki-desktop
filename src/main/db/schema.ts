import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const library = sqliteTable(
  "library",
  {
    animeId: text("anime_id").notNull(),
    sourceId: text("source_id").notNull(),
    category: text("category").notNull(), // watching | planned | completed | dropped | on_hold | favorite | saved
    addedAt: integer("added_at").notNull(),
    animeJson: text("anime_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.animeId] })],
);

export const watchProgress = sqliteTable(
  "watch_progress",
  {
    sourceId: text("source_id").notNull(),
    titleId: text("title_id").notNull(),
    episodeId: text("episode_id").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    // The playback group this episode was watched under - lets a "continue watching" card jump
    // straight into `/watch/$sourceId/$animeId/$groupId/$episodeId` instead of only ever landing
    // on the anime detail page (which has to be told a group anyway before it can build that same
    // URL itself). Null for progress saved before this column existed.
    groupId: text("group_id"),
    quality: text("quality"),
    // The dub studio/player this episode was last watched through (see watch route's `link`) -
    // resuming picks a matching link over the source's default priority order when one's
    // available, so switching to "Английская озвучка" once actually sticks across episodes/
    // sessions instead of quietly reverting the next time this title's watched.
    translation: text("translation"),
    playerName: text("player_name"),
    positionMs: integer("position_ms").notNull(),
    durationMs: integer("duration_ms").notNull(),
    watched: integer("watched", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at").notNull(),
    // A JPEG data URL of the last frame seen for this episode (see VideoPlayer's
    // onCaptureThumbnail) - powers the history page's per-episode thumbnails. Null until the first
    // capture, and for episodes saved before this column existed.
    thumbnailDataUrl: text("thumbnail_data_url"),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.titleId, t.episodeId] })],
);

export const dailyActivity = sqliteTable("daily_activity", {
  date: text("date").primaryKey(), // YYYY-MM-DD
  watchedMs: integer("watched_ms").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
});

export const sourceRepositories = sqliteTable("source_repositories", {
  url: text("url").primaryKey(),
  addedAt: integer("added_at").notNull(),
});

// One row per achievement tier actually cleared (see achievements.ts's tiersClearedInRange) - the
// only genuinely discrete "+N XP" moments in the whole system. The steady per-hour-watched trickle
// (levelProgress.ts) isn't logged here at all - it's a continuous total, not a series of events,
// and would just be noise at one entry every 6 minutes of watching.
export const xpEvents = sqliteTable("xp_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(), // an achievement tier id, e.g. "collector_10"
  xp: integer("xp").notNull(),
  createdAt: integer("created_at").notNull(),
});

// One row per episode a download actually finished for (see main/ipc/downloads.ts) - the
// foundation offline viewing is built on. `filePath` points at wherever it landed under this
// app's own userData/downloads folder.
export const downloadedEpisodes = sqliteTable(
  "downloaded_episodes",
  {
    sourceId: text("source_id").notNull(),
    animeId: text("anime_id").notNull(),
    groupId: text("group_id").notNull(),
    episodeId: text("episode_id").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    episodeLabel: text("episode_label").notNull(),
    filePath: text("file_path").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    // Summed from the source HLS playlist's own #EXTINF values while downloading (see
    // downloadHls) - null for a DIRECT_MP4 download (that container reports its own real duration
    // natively, no synthetic playlist/wrapper ever needed for it) or for an episode downloaded
    // before this column existed.
    durationMs: integer("duration_ms"),
    // The PlayerLink's own `quality` at the time it was downloaded (e.g. "720p") - lets offline
    // playback show what quality the file actually is instead of a dash, and mark that row as
    // fixed/non-switchable rather than offering picks from the live source's quality list, which
    // doesn't apply to a file already on disk. Null for an episode downloaded before this column
    // existed, or from a source whose links never carried a quality label to begin with.
    quality: text("quality"),
    downloadedAt: integer("downloaded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.animeId, t.episodeId] })],
);

// A snapshot of an anime's own detail (description, genres, poster, ...) taken the moment one of
// its episodes finishes downloading - lets the title page still show something meaningful (short
// of playback of anything not itself downloaded) when the source it came from isn't reachable.
// Deliberately excludes relatedAnime/franchiseAnime/similarAnime (see sources.ts's own stripping
// before this gets written) - those aren't useful offline anyway (nothing to navigate to) and
// would otherwise be the single biggest thing bloating this table.
export const cachedAnime = sqliteTable(
  "cached_anime",
  {
    sourceId: text("source_id").notNull(),
    animeId: text("anime_id").notNull(),
    animeJson: text("anime_json").notNull(),
    cachedAt: integer("cached_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.animeId] })],
);

// Same idea as cachedAnime, but for its playback groups/episode list - the title page's episode
// grid needs this to render offline too, not just the description above it.
export const cachedPlaybackGroups = sqliteTable(
  "cached_playback_groups",
  {
    sourceId: text("source_id").notNull(),
    animeId: text("anime_id").notNull(),
    groupsJson: text("groups_json").notNull(),
    cachedAt: integer("cached_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.animeId] })],
);

// Whole *result lists* a source screen was last built from - the home page's hero row and its
// "popular" pool, a source's latest feed. cachedAnime above answers "what is this one title",
// which is not enough to paint a screen that doesn't yet know which titles it is about.
//
// Keyed by a caller-chosen string rather than by the request shape, on purpose: the home pool is
// fetched at a random offset every visit, and the point is to paint the *previous* visit's slice
// while the new one loads, not to look for an exact match that will never be there.
export const cachedSourceQueries = sqliteTable("cached_source_queries", {
  queryKey: text("query_key").primaryKey(),
  titlesJson: text("titles_json").notNull(),
  cachedAt: integer("cached_at").notNull(),
});

// Which AniList entry a given source title was matched to. Separate from anilistMedia below on
// purpose: the same AniList entry backs the same show on every installed source, and a match is
// expensive to establish (a search request plus scoring) while the media it points at is merely a
// cache line that can be thrown away and refetched.
//
// `manual` marks a binding the user fixed by hand on the title page. Automatic re-matching must
// never overwrite one - a wrong match on a sequel or a recap is exactly the case the user reached
// for that button to fix, and silently undoing it on the next refresh would make the button
// useless.
export const anilistMatches = sqliteTable(
  "anilist_matches",
  {
    sourceId: text("source_id").notNull(),
    animeId: text("anime_id").notNull(),
    // Null records a *failed* search, which is worth remembering: without it every visit to a
    // title AniList simply does not have re-runs the same fruitless search.
    anilistId: integer("anilist_id"),
    confidence: integer("confidence"), // 0..100, null for manual bindings
    manual: integer("manual", { mode: "boolean" }).notNull().default(false),
    matchedAt: integer("matched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.animeId] })],
);

// The AniList entries themselves, keyed by their own id and shared across sources - two sources
// carrying the same show cost one cached row and one request, not two.
export const anilistMedia = sqliteTable("anilist_media", {
  anilistId: integer("anilist_id").primaryKey(),
  mediaJson: text("media_json").notNull(), // an ExternalMetadata (see shared/anilistMetadata.ts)
  cachedAt: integer("cached_at").notNull(),
});
