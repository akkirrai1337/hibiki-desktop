export const IPC = {
  sourcesList: "sources:list",
  sourceSearch: "source:search",
  sourceLatest: "source:latest",
  sourceGetById: "source:getById",
  sourcePlaybackGroups: "source:playbackGroups",
  sourcePlayerLinks: "source:playerLinks",
  sourceResolvePlayerLink: "source:resolvePlayerLink",
  sourceFilterCatalog: "source:filterCatalog",

  sourcesRepositoriesList: "sources:repositories:list",
  sourcesRepositoriesAdd: "sources:repositories:add",
  sourcesRepositoriesRemove: "sources:repositories:remove",
  sourcesMarketplaceFetch: "sources:marketplace:fetch",
  sourcesInstall: "sources:install",
  sourcesUninstall: "sources:uninstall",
  sourcesResolverVersions: "sources:resolverVersions",

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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
