import { describe, expect, it } from "vitest";
import { groupByDay, startOfDay, upcomingRelease } from "./releaseCalendar";
import type { AnimeTitle } from "@shared/types";

const DAY = 86_400_000;
const now = new Date(2026, 8, 29, 15, 0).getTime();
const title = (fields: Partial<AnimeTitle>): AnimeTitle => ({ id: "1", sourceId: "s", ...fields });

describe("upcomingRelease", () => {
  it("keeps a release later today even though its clock time has passed", () => {
    const at = new Date(2026, 8, 29, 9, 0).getTime();
    expect(upcomingRelease(title({ nextEpisodeAt: at }), now)).toBe(at);
  });
  it("drops yesterday, finished shows, missing dates and dates past the horizon", () => {
    expect(upcomingRelease(title({ nextEpisodeAt: now - DAY }), now)).toBeNull();
    expect(upcomingRelease(title({ nextEpisodeAt: now + DAY, status: "released" }), now)).toBeNull();
    expect(upcomingRelease(title({ nextEpisodeAt: null }), now)).toBeNull();
    expect(upcomingRelease(title({ nextEpisodeAt: now + 30 * DAY }), now)).toBeNull();
  });
});

describe("groupByDay", () => {
  it("groups by local day in ascending order", () => {
    const a = { anime: title({ id: "a" }), at: now + 2 * DAY };
    const b = { anime: title({ id: "b" }), at: now };
    const c = { anime: title({ id: "c" }), at: now + 2 * DAY + 3_600_000 };
    const days = groupByDay([a, b, c]);
    expect(days.map((d) => d.day)).toEqual([startOfDay(now), startOfDay(now + 2 * DAY)]);
    expect(days[1].entries.map((e) => e.anime.id)).toEqual(["a", "c"]);
  });
});
