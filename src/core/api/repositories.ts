import { eq } from "drizzle-orm";
import type { HibikiApi } from "@shared/hibikiApi";
import type { RepositoryFetchResult } from "@shared/types";
import { sourceRepositories } from "../db/schema";
import { DEFAULT_REPOSITORY_URL, fetchRepositoryIndex, fetchRepositoryResult, isHttpsRepositoryUrl } from "../marketplace";
import { getPlatform } from "../platform";

const getDb = () => getPlatform().db.get();

async function listRepositoryUrls(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select().from(sourceRepositories).all();
  // First run: nothing installed and no repository configured yet — seed the built-in
  // hibiki-sources repository so the marketplace isn't empty out of the box.
  if (rows.length === 0) {
    await db.insert(sourceRepositories).values({ url: DEFAULT_REPOSITORY_URL, addedAt: Date.now() }).run();
    return [DEFAULT_REPOSITORY_URL];
  }
  return rows.map((r) => r.url);
}

/** The repository list and marketplace browsing parts of `window.hibiki.sources`. */
export function createRepositoriesApi(): Pick<HibikiApi["sources"], "repositories" | "marketplace"> {
  return {
    repositories: {
      list: (): Promise<string[]> => listRepositoryUrls(),

      async add(url: string): Promise<string[]> {
        if (!isHttpsRepositoryUrl(url)) throw new Error("Repository URL must use HTTPS");
        await fetchRepositoryIndex(url); // validates it's actually a repository index before saving
        await getDb().insert(sourceRepositories).values({ url, addedAt: Date.now() }).onConflictDoNothing().run();
        return listRepositoryUrls();
      },

      async remove(url: string): Promise<string[]> {
        await getDb().delete(sourceRepositories).where(eq(sourceRepositories.url, url)).run();
        return listRepositoryUrls();
      },
    },

    marketplace: (urls: string[]): Promise<RepositoryFetchResult[]> => Promise.all(urls.map(fetchRepositoryResult)),
  };
}
