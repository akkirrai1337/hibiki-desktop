// Talks to hibiki-sources-style repositories over plain HTTPS: a `repository/index.json` listing
// available extensions, and a `<id>.manifest.json` + `<id>.js` pair per extension (see
// hibiki-sources' own layout) — the exact same convention the Android app's
// ExtensionMarketplaceClient speaks, so both clients can share a repository. Unlike Android,
// which merges manifest+payload into one on-device JSON file, the desktop runtime already reads
// extensions as separate `<id>.manifest.json`/`<id>.js` files (see extensions/runtime.ts), so
// installing here just means fetching and writing those two files as-is — no merge step needed.
import type { MarketplaceExtension, RepositoryFetchResult } from "@shared/types";

export const DEFAULT_REPOSITORY_URL =
  "https://raw.githubusercontent.com/akkirrai1337/hibiki-sources/main/repository/index.json";

const MANIFEST_SUFFIX = ".manifest.json";
const GITHUB_RAW_MAIN_URL = /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/main\/(.+)$/;

export function isHttpsRepositoryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host.length > 0;
  } catch {
    return false;
  }
}

// raw.githubusercontent.com sits behind a CDN that caches each URL for a few minutes and ignores
// no-cache request headers from anonymous clients — a per-request query param is the only
// reliable bypass, and the fully-qualified branch ref (.../refs/heads/main/...) reaches the fresh
// object more reliably than the short branch form. Mirrors the Android client's workaround.
function stableUrl(url: string): string {
  const withStableRef = url.replace(GITHUB_RAW_MAIN_URL, (_m, repo, rest) => `${repo}/refs/heads/main/${rest}`);
  const separator = withStableRef.includes("?") ? "&" : "?";
  return `${withStableRef}${separator}cachebust=${Date.now()}`;
}

async function getText(url: string, label: string): Promise<string> {
  if (!isHttpsRepositoryUrl(url)) throw new Error(`${label} URL must use HTTPS`);
  const response = await fetch(stableUrl(url), {
    headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
  });
  if (!response.ok) throw new Error(`${label} request failed: HTTP ${response.status}`);
  return response.text();
}

export async function fetchRepositoryIndex(url: string): Promise<MarketplaceExtension[]> {
  const text = await getText(url, "Repository index");
  let parsed: { schemaVersion?: number; extensions?: MarketplaceExtension[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Repository index is invalid");
  }
  return parsed.extensions ?? [];
}

export async function fetchRepositoryResult(url: string): Promise<RepositoryFetchResult> {
  try {
    return { url, ok: true, extensions: await fetchRepositoryIndex(url) };
  } catch (error) {
    return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function payloadUrlFor(manifestUrl: string): string {
  if (!manifestUrl.endsWith(MANIFEST_SUFFIX)) {
    throw new Error(`Manifest URL doesn't follow the <id>${MANIFEST_SUFFIX} convention: ${manifestUrl}`);
  }
  return manifestUrl.slice(0, -MANIFEST_SUFFIX.length) + ".js";
}

export async function fetchExtensionFiles(
  extension: MarketplaceExtension,
): Promise<{ manifestJson: string; jsPayload: string }> {
  const manifestJson = await getText(extension.manifestUrl, `manifest for '${extension.id}'`);
  const jsPayload = await getText(payloadUrlFor(extension.manifestUrl), `payload for '${extension.id}'`);
  return { manifestJson, jsPayload };
}

/** Basic-semver (x.y.z) comparison; a non-matching string never triggers an update prompt. */
export function isExtensionVersionNewer(remoteVersion: string, installedVersion: string): boolean {
  const remote = remoteVersion.trim().split(".").map(Number).filter((n) => !Number.isNaN(n));
  const installed = installedVersion.trim().split(".").map(Number).filter((n) => !Number.isNaN(n));
  if (remote.length === 0 || installed.length === 0) return false;
  for (let i = 0; i < Math.max(remote.length, installed.length); i++) {
    const comparison = (remote[i] ?? 0) - (installed[i] ?? 0);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}
