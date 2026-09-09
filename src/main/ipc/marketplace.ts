import { ipcMain } from "electron";
import { eq } from "drizzle-orm";
import { IPC } from "@shared/ipc";
import type { InstalledVersions, MarketplaceExtension, RepositoryFetchResult, SourceInfo } from "@shared/types";
import { getDb } from "../db";
import { sourceRepositories } from "../db/schema";
import { DEFAULT_REPOSITORY_URL, fetchExtensionFiles, fetchRepositoryIndex, fetchRepositoryResult, isHttpsRepositoryUrl } from "../marketplace";
import type { ExtensionRuntime } from "../extensions/runtime";

// A source's resolverDependencies (e.g. YummyAnime needs "kodik", "sibnet", ...) are hidden
// dependencies, not something the user installs themselves - mirrors the Android app, which
// installs them silently alongside the source and never lists them in its source picker (see
// ExtensionRuntime's separate resolversDir). Best-effort: a resolver failing to fetch/install
// just means its EMBED links fall back to the existing iframe player instead of a direct stream,
// not a broken install.
async function installResolverDependencies(dependencyIds: string[], originUrl: string, runtime: ExtensionRuntime): Promise<void> {
  if (dependencyIds.length === 0) return;
  let index: MarketplaceExtension[];
  try {
    index = await fetchRepositoryIndex(originUrl);
  } catch {
    return;
  }
  const resolversById = new Map(index.filter((e) => e.type === "player-resolver").map((e) => [e.id, e]));
  for (const id of dependencyIds) {
    const resolverExtension = resolversById.get(id);
    if (!resolverExtension) continue;
    try {
      const { manifestJson, jsPayload } = await fetchExtensionFiles(resolverExtension);
      runtime.installResolver(id, manifestJson, jsPayload);
    } catch (error) {
      console.warn(`Failed to install resolver "${id}":`, error);
    }
  }
}

function listRepositoryUrls(): string[] {
  const db = getDb();
  const rows = db.select().from(sourceRepositories).all();
  // First run: nothing installed and no repository configured yet — seed the built-in
  // hibiki-sources repository so the marketplace isn't empty out of the box.
  if (rows.length === 0) {
    db.insert(sourceRepositories).values({ url: DEFAULT_REPOSITORY_URL, addedAt: Date.now() }).run();
    return [DEFAULT_REPOSITORY_URL];
  }
  return rows.map((r) => r.url);
}

/** Tells the renderer its picture of what's installed is out of date. Sent after every mutation
 * rather than left to each caller, since forgetting one is invisible until someone notices a
 * screen showing an update that has already been applied. */
function notifyChanged(sender: Electron.WebContents): void {
  if (!sender.isDestroyed()) sender.send(IPC.sourcesChanged);
}

export function registerMarketplaceHandlers(runtime: ExtensionRuntime): void {
  ipcMain.handle(IPC.sourcesRepositoriesList, (): string[] => listRepositoryUrls());

  ipcMain.handle(IPC.sourcesRepositoriesAdd, async (_e, url: string): Promise<string[]> => {
    if (!isHttpsRepositoryUrl(url)) throw new Error("Repository URL must use HTTPS");
    await fetchRepositoryIndex(url); // validates it's actually a repository index before saving
    getDb().insert(sourceRepositories).values({ url, addedAt: Date.now() }).onConflictDoNothing().run();
    return listRepositoryUrls();
  });

  ipcMain.handle(IPC.sourcesRepositoriesRemove, (_e, url: string): string[] => {
    getDb().delete(sourceRepositories).where(eq(sourceRepositories.url, url)).run();
    return listRepositoryUrls();
  });

  ipcMain.handle(IPC.sourcesMarketplaceFetch, (_e, urls: string[]): Promise<RepositoryFetchResult[]> =>
    Promise.all(urls.map(fetchRepositoryResult)),
  );

  ipcMain.handle(
    IPC.sourcesInstall,
    async (event, extension: MarketplaceExtension, originUrl: string): Promise<SourceInfo[]> => {
      const { manifestJson, jsPayload } = await fetchExtensionFiles(extension);
      runtime.install(extension.id, manifestJson, jsPayload, originUrl);
      await installResolverDependencies(extension.resolverDependencies, originUrl, runtime);
      notifyChanged(event.sender);
      return runtime.list();
    },
  );

  // Both halves read from the same runtime state in the same tick, so they cannot disagree.
  ipcMain.handle(IPC.sourcesInstalledVersions, (): InstalledVersions => ({
    sources: Object.fromEntries(runtime.installedVersions()),
    resolvers: runtime.installedResolverVersions(),
  }));

  ipcMain.handle(IPC.sourcesUninstall, (event, id: string): SourceInfo[] => {
    runtime.uninstall(id);
    notifyChanged(event.sender);
    return runtime.list();
  });
}
