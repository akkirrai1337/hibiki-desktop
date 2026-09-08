// Real implementations of challenge()/browserFetch() (see browserBridge.ts), using a hidden,
// real-Chromium BrowserWindow - the actual GUI-capable Electron APIs these need only exist on
// Electron's main thread, so this file must only ever be called from there (runtime.ts, in
// response to a bridge request forwarded from the extension's worker_thread - see
// syncHostBridge.ts for the worker side of that bridge).
import { BrowserWindow } from "electron";
import type { BrowserFetchResult, ChallengeSession } from "./browserBridge";

// Cloudflare-style interstitials run a few seconds of JS (proof-of-work / redirect chain) before
// the real page or cookies are ready - loadURL's own promise resolves once the *interstitial*
// finishes loading, not once it's done solving itself, so there's no better signal than a fixed
// settle delay to wait on here.
const CHALLENGE_SETTLE_MS = 4000;

// One search/title/episode-list screen makes several independent search()/getById()/
// playbackGroups() calls back-to-back, and each used to spin up its own fresh hidden window and
// reload the page from scratch - several full page loads within a couple seconds is exactly the
// kind of burst that trips a site's own rate limiter (seen live: Miruro starting to answer with
// HTTP 429 once search+getById+playbackGroups landed almost simultaneously). Pooling one window
// per page origin and reusing it (skipping the reload + settle wait entirely once it's already
// loaded) cuts that down to one real page load per session instead of one per call.
const WINDOW_IDLE_TTL_MS = 5 * 60_000;
const pool = new Map<string, { window: BrowserWindow; loadedAt: number }>();

function getPooledWindow(key: string): BrowserWindow | null {
  const entry = pool.get(key);
  if (!entry) return null;
  if (entry.window.isDestroyed() || Date.now() - entry.loadedAt > WINDOW_IDLE_TTL_MS) {
    if (!entry.window.isDestroyed()) entry.window.destroy();
    pool.delete(key);
    return null;
  }
  return entry.window;
}

async function acquireLoadedWindow(key: string, url: string, forceReload: boolean): Promise<BrowserWindow> {
  const existing = !forceReload && getPooledWindow(key);
  if (existing) return existing;

  const previous = pool.get(key);
  if (previous && !previous.window.isDestroyed()) previous.window.destroy();

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, images: false } });
  win.on("closed", () => {
    if (pool.get(key)?.window === win) pool.delete(key);
  });
  if (forceReload) await win.webContents.session.clearStorageData({ origin: new URL(url).origin });
  await win.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, CHALLENGE_SETTLE_MS));
  pool.set(key, { window: win, loadedAt: Date.now() });
  return win;
}

/** Releases every pooled window - call on app quit so no hidden renderer processes linger. */
export function destroyAllPooledWindows(): void {
  for (const { window } of pool.values()) if (!window.isDestroyed()) window.destroy();
  pool.clear();
}

const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2500, 5000];
// 429 is the standard "too many requests" signal; 444 is an Nginx-ism for "closing the connection
// without a response" that some CDNs reuse defensively against bursty/bot-like traffic (seen live
// on Miruro's own player-source endpoint) - both are worth a short backoff-and-retry rather than
// failing the whole request outright.
const RETRYABLE_STATUSES = new Set([429, 444]);

export async function performBrowserFetch(
  pageUrl: string,
  targetUrl: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<BrowserFetchResult> {
  const requestInit = {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
    body: options?.body,
    credentials: "include" as const,
  };
  const script = `
    fetch(${JSON.stringify(targetUrl)}, ${JSON.stringify(requestInit)})
      .then(async (res) => ({
        status: res.status,
        ok: res.ok,
        body: await res.text(),
        headers: Object.fromEntries(res.headers.entries()),
      }))
      .catch((error) => ({ status: 0, ok: false, body: "", headers: {}, __error: String(error) }));
  `;

  for (let attempt = 0; ; attempt++) {
    const win = await acquireLoadedWindow(pageUrl, pageUrl, false);
    // Runs inside the page itself, so it carries whatever cookies/session the challenge just
    // established and matches that page's own TLS/JS fingerprint - the entire point of routing
    // this through a real browser context instead of our own fetch().
    const result = await win.webContents.executeJavaScript(script);
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(`browserFetch() in-page request failed: ${(result as { __error: string }).__error}`);
    }
    if (!RETRYABLE_STATUSES.has(result.status) || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) return result as BrowserFetchResult;
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAYS_MS[attempt]));
  }
}

export async function performChallenge(url: string, cookieNames: string[], forceRefresh: boolean): Promise<ChallengeSession> {
  const origin = new URL(url).origin;
  const win = await acquireLoadedWindow(origin, url, forceRefresh);

  const userAgent = win.webContents.getUserAgent();
  const allCookies = await win.webContents.session.cookies.get({ url });
  const wanted = cookieNames.length > 0 ? allCookies.filter((c) => cookieNames.includes(c.name)) : allCookies;

  const cookies: Record<string, string> = {};
  for (const cookie of wanted) cookies[cookie.name] = cookie.value;
  const cookieHeader = wanted.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

  return { cookies, cookieHeader, userAgent };
}
