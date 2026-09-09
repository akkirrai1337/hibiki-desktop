import type { PlayerLink } from "@shared/types";

// Everything about *which* of an episode's links should play, in one place. This logic used to be
// split between the watch route (which link to start on) and VideoPlayer's settings menu (which
// link a manual pick maps to), with neither half aware of the other - which is how picking 720p on
// Alloha could silently land on Kodik's 720p, and how resuming an Alloha episode played Kodik for
// a moment first. Pure functions on purpose: this is the part that was impossible to test while it
// lived inside component bodies.

// Mirrors Android's PlaybackResolver: prefer a directly playable stream over handing the user a
// third-party embed page. This app doesn't run per-provider embed extractors in the renderer, so
// the ordering approximates it by preferring whichever direct link a source already returned.
const LINK_TYPE_PRIORITY: Record<string, number> = { DIRECT_HLS: 0, DIRECT_MP4: 0, DIRECT_DASH: 0, EMBED: 1 };

export interface PlaybackPreference {
  translation?: string | null;
  playerName?: string | null;
}

/** The starting pick when there is nothing saved to honour: any direct stream over an embed. */
export function pickDefaultLink<T extends { type: string }>(links: T[] | undefined): T | undefined {
  if (!links || links.length === 0) return undefined;
  return [...links].sort((a, b) => (LINK_TYPE_PRIORITY[a.type] ?? 0) - (LINK_TYPE_PRIORITY[b.type] ?? 0))[0];
}

/**
 * The link matching what was last watched through. Both halves of the preference count, so a dub
 * that is still available wins over neither matching; returns undefined when nothing matches at
 * all, which is the caller's cue to fall back to pickDefaultLink().
 */
export function pickPreferredLink(links: PlayerLink[], preference: PlaybackPreference): PlayerLink | undefined {
  const { translation, playerName } = preference;
  if (!translation && !playerName) return undefined;
  return links
    .map((link) => ({
      link,
      score: (link.translation === translation ? 1 : 0) + (link.playerName === playerName ? 1 : 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.link;
}

/** Distinct, non-empty values of one field across a set of links. */
function distinctValues(links: PlayerLink[], pick: (link: PlayerLink) => string | null | undefined): string[] {
  return [...new Set(links.map(pick).filter((value): value is string => !!value))];
}

export function translationOptions(links: PlayerLink[]): string[] {
  return distinctValues(links, (link) => link.translation);
}

export function playerOptions(links: PlayerLink[]): string[] {
  return distinctValues(links, (link) => link.playerName);
}

/**
 * The links that belong to the stream currently playing - same provider, same dub. A quality is a
 * rendition of one provider's stream, so mixing every link of the episode into one list is what
 * made an Alloha 720p pick jump to Kodik.
 */
export function linksForCurrentStream(links: PlayerLink[], current: PlayerLink): PlayerLink[] {
  return links.filter(
    (link) => link.playerName === current.playerName && link.translation === current.translation,
  );
}

// -Infinity, so labels carrying no resolution at all ("auto", "source", ...) still sort last now
// that the list runs highest-first.
function qualityValue(label: string): number {
  const match = label.match(/\d{3,4}/);
  return match ? Number.parseInt(match[0], 10) : Number.NEGATIVE_INFINITY;
}

/** Qualities of the current stream, descending by resolution (labels without a number sort last). */
export function qualityOptions(links: PlayerLink[], current: PlayerLink): string[] {
  return distinctValues(linksForCurrentStream(links, current), (link) => link.quality)
    .sort((a, b) => qualityValue(b) - qualityValue(a) || a.localeCompare(b));
}

/**
 * Switching one dimension (dub, provider, quality) while keeping the other two wherever possible:
 * picking a different dub shouldn't reset an already-chosen provider if that combination exists.
 * Returns undefined when nothing carries the requested value.
 */
export function pickLinkForDimension(
  links: PlayerLink[],
  current: PlayerLink,
  changed: Partial<Pick<PlayerLink, "translation" | "playerName" | "quality">>,
): PlayerLink | undefined {
  const target = { translation: current.translation, playerName: current.playerName, quality: current.quality, ...changed };
  const entries = Object.entries(changed) as [keyof typeof changed, string | null | undefined][];
  return links
    .filter((link) => entries.every(([key, value]) => link[key] === value))
    .map((link) => ({
      link,
      score:
        (link.translation === target.translation ? 1 : 0) +
        (link.playerName === target.playerName ? 1 : 0) +
        (link.quality === target.quality ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.link;
}

/** A quality pick stays inside the stream that is playing - see linksForCurrentStream(). */
export function pickLinkForQuality(
  links: PlayerLink[],
  current: PlayerLink,
  quality: string,
): PlayerLink | undefined {
  return linksForCurrentStream(links, current).find((link) => link.quality === quality);
}

/**
 * An EMBED link resolves into a whole set of renditions, so the pick that got us there has to
 * survive the expansion - taking the default outright is what made an explicit quality choice look
 * like it snapped back to whatever the source lists first.
 */
export function pickResolvedLink(playable: PlayerLink[], requested: PlayerLink): PlayerLink | undefined {
  const sameQuality = requested.quality
    ? playable.find((link) => link.quality === requested.quality)
    : undefined;
  return sameQuality ?? pickDefaultLink(playable);
}

/**
 * The provider a URL belongs to, rather than the exact host serving it.
 *
 * Kodik hands out p12/p13/p14.solodcdn.com for the very same library, and scoring by full origin
 * read those as three unrelated routes - enough to send a fallback down to 360p on a neighbouring
 * edge node while a working 480p sat on the one that had just failed. The last two labels are a
 * rough stand-in for the registrable domain; where it is too rough, two genuinely distinct
 * providers merely stop being credited for the difference, which is the harmless direction.
 */
function linkProvider(url: string): string | null {
  try {
    const labels = new URL(url).hostname.split(".");
    return labels.length <= 2 ? labels.join(".") : labels.slice(-2).join(".");
  } catch {
    return null;
  }
}

/** Picks a genuinely different route after one stream has exhausted its retries. */
export function pickPlaybackFallback(
  links: PlayerLink[],
  failed: PlayerLink,
  excludedUrls: ReadonlySet<string>,
): PlayerLink | undefined {
  const failedProvider = linkProvider(failed.url);
  return links
    .filter((link) => link.url !== failed.url && !excludedUrls.has(link.url))
    .map((link, index) => {
      const provider = linkProvider(link.url);
      const score =
        (provider && failedProvider && provider !== failedProvider ? 100 : 0) +
        (link.translation === failed.translation ? 20 : 0) +
        (link.playerName === failed.playerName ? 10 : 0) +
        (link.type !== "EMBED" ? 5 : 0);
      return { link, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.link;
}
