// BrowserPort on Android: hidden WebViews (HibikiBrowser plugin). A challenge page that does not pass
// by itself within a few seconds is shown to the user, the way the Kotlin app does it - Cloudflare's
// interactive checks need a person. One challenge per origin at a time, so two calls racing for the
// same site share one page instead of tearing each other's down.
import type { BrowserPort, ChallengeSession } from "../types";
import { HibikiBrowser } from "./native";

const SHOW_AFTER_MS = 8_000;
const GIVE_UP_AFTER_MS = 120_000;
const POLL_MS = 600;

// Same markers desktop's browserFetchHost.ts probes for: a "still challenged?" test, since the app
// cannot know what a source's real page looks like but does know what an interstitial looks like.
const CHALLENGE_PROBE_SCRIPT = `
  (function () {
    var title = (document.title || "").toLowerCase();
    var challenged = /just a moment|attention required|checking your browser|verifying you are human|один момент/.test(title)
      || !!document.querySelector("#challenge-running, #challenge-form, #cf-chl-widget, .cf-browser-verification, #turnstile-wrapper");
    return { challenged: challenged, ready: document.readyState === "complete" };
  })();
`;

function parseCookies(header: string): Array<[string, string]> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return index > 0 ? ([part.slice(0, index), part.slice(index + 1)] as [string, string]) : null;
    })
    .filter((pair): pair is [string, string] => pair !== null);
}

const challengesByOrigin = new Map<string, Promise<ChallengeSession>>();

async function solveChallenge(url: string, cookieNames: string[], forceRefresh: boolean): Promise<ChallengeSession> {
  const key = `challenge:${new URL(url).origin}`;
  await HibikiBrowser.open({ key, url, clearOrigin: forceRefresh });
  try {
    const startedAt = Date.now();
    let shown = false;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      let state = { challenged: true, ready: false };
      try {
        state = JSON.parse((await HibikiBrowser.eval({ key, js: CHALLENGE_PROBE_SCRIPT })).value || "null") ?? state;
      } catch {
        // Navigating between the interstitial and the real page: progress, keep waiting.
      }
      if (state.ready && !state.challenged) break;
      const elapsed = Date.now() - startedAt;
      if (!shown && elapsed > SHOW_AFTER_MS) {
        shown = true;
        await HibikiBrowser.show({ key });
      }
      if (elapsed > GIVE_UP_AFTER_MS) throw new Error(`challenge for ${url} was not passed`);
    }
    const userAgent = (await HibikiBrowser.userAgent()).value;
    const all = parseCookies((await HibikiBrowser.cookies({ url })).value);
    const wanted = cookieNames.length > 0 ? all.filter(([name]) => cookieNames.includes(name)) : all;
    return {
      cookies: Object.fromEntries(wanted),
      cookieHeader: wanted.map(([name, value]) => `${name}=${value}`).join("; "),
      userAgent,
    };
  } finally {
    await HibikiBrowser.close({ key }).catch(() => {});
  }
}

const notYet = (what: string) => Promise.reject(new Error(`${what} is not supported on Android yet`));

export const androidBrowser: BrowserPort = {
  challenge(url, cookieNames, forceRefresh) {
    const origin = new URL(url).origin;
    const running = challengesByOrigin.get(origin);
    if (running && !forceRefresh) return running;
    const pending = solveChallenge(url, cookieNames, forceRefresh).finally(() => {
      if (challengesByOrigin.get(origin) === pending) challengesByOrigin.delete(origin);
    });
    challengesByOrigin.set(origin, pending);
    return pending;
  },
  browserFetch: () => notYet("browserFetch()"),
  resolve: () => notYet("A browser-based player resolver"),
  login: () => notYet("Signing in through the site"),
  dispose() {},
};
