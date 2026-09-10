export const IPC = {
  sourcesList: "sources:list",
  sourceSearch: "source:search",
  sourceSearchCancel: "source:search:cancel",
  sourceLatest: "source:latest",
  sourceGetById: "source:getById",
  // Whatever is already on disk for a set of titles - lets a screen paint before the network
  // answers. See offlineCache.getCachedAnimeMany.
  sourceCachedTitles: "source:cachedTitles",
  sourceCachedPlaybackGroups: "source:cachedPlaybackGroups",
  // The last title list a source screen was built from, and the write that records it. See
  // offlineCache.cacheSourceQuery.
  sourceCachedQuery: "source:cachedQuery",
  sourceCacheQuery: "source:cacheQuery",
  sourcePlaybackGroups: "source:playbackGroups",
  sourcePlayerLinks: "source:playerLinks",
  sourceResolvePlayerLink: "source:resolvePlayerLink",
  sourceFilterCatalog: "source:filterCatalog",

  // Account, and what an account unlocks. Each is answered only by sources that declare the
  // matching capability - see SourceCapability.
  sourceLogin: "source:account:login",
  sourceLogout: "source:account:logout",
  sourceAccount: "source:account:get",
  sourceComments: "source:comments:list",
  sourcePostComment: "source:comments:post",
  sourceReviews: "source:reviews:list",
  sourcePostReview: "source:reviews:post",
  sourceSyncLibraryEntry: "source:library:sync",
  sourceListLibrary: "source:library:list",
  sourceReportPlayback: "source:activity:report",
  sourcePingOnline: "source:activity:ping",
  // Values for the settings rows a source declares. The same store the script reads, so a toggle
  // flipped here is a value the source can act on.
  sourceSettingsRead: "source:settings:read",
  sourceSettingsWrite: "source:settings:write",

  sourcesRepositoriesList: "sources:repositories:list",
  sourcesRepositoriesAdd: "sources:repositories:add",
  sourcesRepositoriesRemove: "sources:repositories:remove",
  sourcesMarketplaceFetch: "sources:marketplace:fetch",
  sourcesInstall: "sources:install",
  sourcesUninstall: "sources:uninstall",
  sourcesInstalledVersions: "sources:installedVersions",
  // Pushed main -> renderer whenever anything is installed or uninstalled, so no caller has to
  // remember to refresh what it just changed - which is exactly what went wrong before.
  sourcesChanged: "sources:changed",

  libraryList: "library:list",
  libraryUpsert: "library:upsert",
  libraryRemove: "library:remove",

  progressGet: "progress:get",
  progressUpsert: "progress:upsert",
  progressListRecent: "progress:listRecent",
  progressListForAnime: "progress:listForAnime",
  progressListDailyActivity: "progress:listDailyActivity",
  progressRemoveForAnime: "progress:removeForAnime",
  progressRemoveEpisode: "progress:removeEpisode",
  progressSaveThumbnail: "progress:saveThumbnail",

  xpEventsList: "xpEvents:list",
  xpEventsRecord: "xpEvents:record",

  downloadsStart: "downloads:start",
  downloadsPause: "downloads:pause",
  downloadsResume: "downloads:resume",
  downloadsCancel: "downloads:cancel",
  downloadsList: "downloads:list",
  downloadsRemove: "downloads:remove",
  downloadsGetForEpisode: "downloads:getForEpisode",
  // Pushed main -> renderer (not a request/response handle) - the only channel in the app that
  // works this way, since a download's progress needs to keep reaching the renderer over the
  // whole transfer instead of resolving once like every other IPC call here does.
  downloadsProgress: "downloads:progress",

  playerRegisterHeaders: "player:registerHeaders",
  playerUnregisterHeaders: "player:unregisterHeaders",
  playerResolveStreamUrl: "player:resolveStreamUrl",
  playerCaptureFrame: "player:captureFrame",

  // AniList metadata: the renderer mirrors its persisted preference into main, which owns the
  // merge (see metadata/metadataPreferences.ts).
  metadataSetPreferences: "metadata:setPreferences",

  discordSetEnabled: "discord:setEnabled",
  discordUpdatePresence: "discord:updatePresence",
  discordSetIdlePresence: "discord:setIdlePresence",
  discordClearPresence: "discord:clearPresence",

  windowUnmaximizeForDrag: "window:unmaximizeForDrag",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggleMaximize",
  windowClose: "window:close",
  windowIsMaximized: "window:isMaximized",
  // Pushed main -> renderer (not a request/response handle), same idea as downloadsProgress above
  // - the window can flip between maximized/restored from several places the renderer never
  // directly asks for (double-clicking the title bar, dragging to a screen edge, Win+Up/Down, the
  // taskbar's own context menu), so the maximize/restore button's icon needs to stay in sync via a
  // push rather than only updating itself right after its own click.
  windowMaximizedChanged: "window:maximizedChanged",

  backupCreate: "backup:create",
  backupRestore: "backup:restore",
  appRelaunch: "app:relaunch",
  logsExport: "logs:export",
  logsRecent: "logs:recent",
  logsAppend: "logs:append",
  logsOpenFolder: "logs:openFolder",
  appGetVersion: "app:getVersion",

  updatesCheck: "updates:check",
  updatesDownloadAndInstall: "updates:downloadAndInstall",
  updatesOpenRelease: "updates:openRelease",
  // Pushed main -> renderer over the whole download, same shape as downloadsProgress above.
  updatesProgress: "updates:progress",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
