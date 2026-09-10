// One serialized, paced request queue per metadata provider.
//
// Both providers rate-limit by IP, and a home screen resolving twelve cards at once would otherwise
// open twelve sockets and collect a 429 for most of them. Requests are chained rather than fired
// in parallel, spaced by the provider's own interval, and a 429 is retried after the delay the
// provider itself asks for - its Retry-After is far more accurate than any backoff guessed here,
// and ignoring it just earns another 429.
import { logger } from "../logger";

// Every request on a queue waits behind the one in front, so a socket that never answers does not
// stall one lookup - it stalls the provider. Nothing here is worth waiting longer than this for:
// the screen that asked has already painted from the source.
const REQUEST_TIMEOUT_MS = 15_000;
// Both APIs answer 429 without a Retry-After often enough to need a floor, and both count per
// minute, so a minute is the honest wait.
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

const queues = new Map<string, { tail: Promise<unknown>; lastRequestAt: number; cooledUntil: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RateLimitedRequest {
  /** Which provider's queue to join - each has its own limit, so they must not share a pace. */
  queue: string;
  minIntervalMs: number;
  /** Log scope, so a rate-limit warning says which provider is being throttled. */
  scope: string;
  url: string;
  init?: RequestInit;
}

/**
 * Runs one request on its provider's queue and parses the JSON body.
 *
 * Null covers every failure - offline, a timeout, a non-2xx status, unparseable JSON, a provider
 * this app is currently standing down from. Callers treat that as "no metadata this time" and keep
 * the source's own, so nothing here throws.
 */
export async function rateLimitedJson<T>({ queue, minIntervalMs, scope, url, init }: RateLimitedRequest): Promise<T | null> {
  const state = queues.get(queue) ?? { tail: Promise.resolve(), lastRequestAt: 0, cooledUntil: 0 };
  queues.set(queue, state);

  const run = async (): Promise<T | null> => {
    // A rate limit is answered by standing down, not by waiting in line. Sleeping out the
    // provider's Retry-After inside the queue held every request behind it for up to a minute -
    // one throttled lookup froze the whole screen's worth. Failing fast costs this lookup its
    // description (the source's own still shows) and lets the rest fail fast too, instead of
    // queueing up to be throttled in turn.
    if (Date.now() < state.cooledUntil) return null;
    const wait = state.lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    state.lastRequestAt = Date.now();
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "");
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_RATE_LIMIT_DELAY_MS;
        state.cooledUntil = Date.now() + delay;
        logger.warn(scope, `rate limited, standing down for ${Math.round(delay / 1000)}s`);
        return null;
      }
      if (!response.ok) {
        logger.warn(scope, `HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      logger.warn(scope, `request failed: ${String(error)}`);
      return null;
    }
  };

  // Chained rather than run immediately: this is the whole rate limiter. Failures are swallowed
  // above, so the tail never rejects and never needs a catch of its own.
  const result = state.tail.then(run);
  state.tail = result;
  return result;
}
