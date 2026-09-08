import { describe, expect, it } from "vitest";
import type { PlayerLink } from "@shared/types";
import {
  pickDefaultLink,
  pickLinkForDimension,
  pickLinkForQuality,
  pickPlaybackFallback,
  pickPreferredLink,
  pickResolvedLink,
  qualityOptions,
} from "./playerLinks";

function link(partial: Partial<PlayerLink> & { url: string }): PlayerLink {
  return { type: "DIRECT_HLS", ...partial };
}

// A realistic episode: two providers, one of them offering a rendition the other doesn't, plus a
// second dub studio. This is the shape both of the shipped bugs needed to reproduce.
const kodik720 = link({ url: "kodik/720", playerName: "Kodik", translation: "Дублированная", quality: "720p" });
const kodik480 = link({ url: "kodik/480", playerName: "Kodik", translation: "Дублированная", quality: "480p" });
const alloha1440 = link({ url: "alloha/1440", playerName: "Alloha", translation: "Дублированная", quality: "1440p" });
const alloha360 = link({ url: "alloha/360", playerName: "Alloha", translation: "Дублированная", quality: "360p" });
const allohaOther = link({ url: "alloha/other", playerName: "Alloha", translation: "AniLibria", quality: "720p" });
const episode = [kodik720, kodik480, alloha1440, alloha360, allohaOther];

describe("pickPlaybackFallback", () => {
  it("prefers another CDN while retaining the same stream identity", () => {
    const failed = link({ url: "https://edge-a.test/720.m3u8", quality: "720p", playerName: "Kodik", translation: "Dub" });
    const sameHost = link({ url: "https://edge-a.test/480.m3u8", quality: "480p", playerName: "Kodik", translation: "Dub" });
    const otherHost = link({ url: "https://edge-b.test/480.m3u8", quality: "480p", playerName: "Kodik", translation: "Dub" });

    expect(pickPlaybackFallback([failed, sameHost, otherHost], failed, new Set([failed.url]))).toBe(otherHost);
  });

  it("never returns a URL that already failed", () => {
    const failed = link({ url: "https://edge-a.test/720.m3u8" });
    const previouslyFailed = link({ url: "https://edge-b.test/480.m3u8" });
    const remaining = link({ url: "https://edge-c.test/360.m3u8" });

    expect(pickPlaybackFallback(
      [failed, previouslyFailed, remaining],
      failed,
      new Set([failed.url, previouslyFailed.url]),
    )).toBe(remaining);
  });
});

describe("pickDefaultLink", () => {
  it("prefers a direct stream over an embed page", () => {
    const embed = link({ url: "embed", type: "EMBED" });
    const direct = link({ url: "direct", type: "DIRECT_MP4" });
    expect(pickDefaultLink([embed, direct])).toBe(direct);
  });

  it("returns undefined for an empty or missing list", () => {
    expect(pickDefaultLink([])).toBeUndefined();
    expect(pickDefaultLink(undefined)).toBeUndefined();
  });
});

describe("pickPreferredLink", () => {
  it("restores the provider and dub that were last watched", () => {
    expect(pickPreferredLink(episode, { translation: "Дублированная", playerName: "Alloha" })).toBe(alloha1440);
  });

  it("prefers a link matching both halves over one matching only the dub", () => {
    expect(pickPreferredLink(episode, { translation: "Дублированная", playerName: "Kodik" })).toBe(kodik720);
  });

  it("falls back to a partial match when the exact combination is gone", () => {
    const preferred = pickPreferredLink(episode, { translation: "Дублированная", playerName: "Sibnet" });
    expect(preferred?.translation).toBe("Дублированная");
  });

  it("returns undefined when nothing matches, so the caller can use the default", () => {
    expect(pickPreferredLink(episode, { translation: "Someone Else", playerName: "Sibnet" })).toBeUndefined();
    expect(pickPreferredLink(episode, {})).toBeUndefined();
  });
});

describe("qualityOptions", () => {
  it("only lists renditions of the stream that is playing", () => {
    // The bug: Kodik's 720p used to show up while Alloha was playing, and picking it switched
    // provider without saying so.
    expect(qualityOptions(episode, alloha1440)).toEqual(["1440p", "360p"]);
    expect(qualityOptions(episode, kodik720)).toEqual(["720p", "480p"]);
  });

  it("sorts by resolution, highest first, rather than by the order the source returned", () => {
    expect(qualityOptions([alloha360, alloha1440], alloha1440)).toEqual(["1440p", "360p"]);
  });

  it("puts labels without a resolution last", () => {
    const auto = link({ url: "alloha/auto", playerName: "Alloha", translation: "Дублированная", quality: "auto" });
    expect(qualityOptions([alloha1440, auto, alloha360], alloha1440)).toEqual(["1440p", "360p", "auto"]);
  });
});

describe("pickLinkForQuality", () => {
  it("stays within the current provider and dub", () => {
    expect(pickLinkForQuality(episode, alloha1440, "360p")).toBe(alloha360);
    // 720p exists in the episode, but not for Alloha - so there is nothing to switch to.
    expect(pickLinkForQuality(episode, alloha1440, "720p")).toBeUndefined();
  });
});

describe("pickLinkForDimension", () => {
  it("keeps the other two dimensions where the combination exists", () => {
    expect(pickLinkForDimension(episode, kodik720, { playerName: "Alloha" })?.playerName).toBe("Alloha");
  });

  it("keeps the closest candidate when the exact combination does not exist", () => {
    // Switching to the AniLibria dub: only Alloha carries it, so the provider has to give.
    const next = pickLinkForDimension(episode, kodik720, { translation: "AniLibria" });
    expect(next).toBe(allohaOther);
  });

  it("returns undefined when nothing carries the requested value", () => {
    expect(pickLinkForDimension(episode, kodik720, { playerName: "Sibnet" })).toBeUndefined();
  });
});

describe("pickResolvedLink", () => {
  it("keeps the requested quality after an embed expands into renditions", () => {
    const requested = link({ url: "embed", type: "EMBED", playerName: "Alloha", quality: "1440p" });
    expect(pickResolvedLink([alloha360, alloha1440], requested)).toBe(alloha1440);
  });

  it("falls back to the default when the resolved set has no such rendition", () => {
    const requested = link({ url: "embed", type: "EMBED", playerName: "Alloha", quality: "2160p" });
    expect(pickResolvedLink([alloha360, alloha1440], requested)).toBe(alloha360);
  });
});
