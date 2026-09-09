# Profile rules: XP, levels, achievements, streaks

The rules behind the profile screen, written down because they are about to exist twice — in
TypeScript here and in Kotlin in the Android app. Two implementations of the same arithmetic drift
silently: the same watch history quietly becomes level 7 on one and level 6 on the other, with
nothing to point at.

The thing to point at is [`src/shared/profileRules.vectors.json`](../src/shared/profileRules.vectors.json)
— generated from this implementation, checked by `profileRules.test.ts` here, and meant to be
checked by the Android port against the same file. **This document explains the rules; the vectors
decide them.** Where the two disagree, the vectors are right.

## Inputs

Everything is derived. There is no achievements table and no stored XP total.

| Input | Where it comes from |
| --- | --- |
| `entries` | library rows: only `category` and `anime.genres` are read |
| `lifetimeWatchedMs` | summed daily watch activity |
| `bestStreak` | the streak rules below, over daily activity |

## Watched hours

`watchedHours = round(lifetimeWatchedMs / 3_600_000 * 10) / 10` — one decimal.

The rounding is part of the rule, not presentation: 23.94 hours rounds to **23.9** and does *not*
clear the 24-hour tier, while 23.96 rounds to 24.0 and does.

Episode-equivalents are separate and floor instead: `floor(lifetimeWatchedMs / 20 minutes)`. This
counts watched time in episode-sized chunks so films and OVAs still progress it.

## Achievement families

Seven families. Each is one card showing the tier currently in progress; clearing a tier moves the
card to the next one rather than leaving a finished card behind. `level` is how many tiers are
cleared, `maxLevel` the family's tier count, and `xpEarned` the sum of the tiers already cleared.

`first_title` is a single untiered achievement (`maxLevel` 1).

| Family | Measured by | Tiers (target → XP) |
| --- | --- | --- |
| `first_title` | library entries | 1 → 5 |
| `collector` | library entries | 10 → 10, 25 → 20, 50 → 40 |
| `finisher` | entries in category `completed` | 1 → 40, 10 → 250, 50 → 900 |
| `streak` | best streak, in days | 7 → 60, 14 → 150, 30 → 400 |
| `watch` | watched hours | 24 → 300, 100 → 900, 500 → 3000 |
| `episodes` | episode-equivalents | 50 → 200, 100 → 450, 300 → 1200 |
| `genres` | distinct genres across entries | 5 → 15, 10 → 35, 15 → 80 |

XP per tier is set by hand, not by tier position. A flat "tier 1 always pays 50" schedule badly
misjudged real cost — 24 hours of watching and adding 10 titles to a list are not the same effort.

`current` is clamped to the active tier's target, so a maxed family reports `500/500`, not
`812/500`.

## XP and levels

```
totalXp = floor(watchedHours * 10) + sum(xpEarned of every family)
```

Levels start at 1. Clearing level *n* costs `100 + (n - 1) * 50` XP, so 100 to reach level 2, 150
more for level 3, and so on. `xpIntoLevel` is the remainder inside the current level and
`xpForLevel` what the current level costs.

## Streaks

Over a series of days, oldest first, where a day is *active* if it has any watched time or any
completed episode. The last day in the series is today.

1. An active day extends the run and refreshes the grace day.
2. **Today never breaks a run.** An inactive today is skipped entirely — it hasn't finished yet —
   and does not consume the grace day. It only sets `atRisk`.
3. A single inactive day (other than today) is forgiven: it consumes the grace day and the run
   continues.
4. A second consecutive inactive day resets the run to zero.
5. The grace day is repaid by the next active day, so it is available again for the next gap
   rather than being once-ever.
6. `best` is the longest run seen anywhere in the series, kept after a break.
7. `atRisk` is true when a run is alive but today is not yet active.

## Changing a rule

1. Change the code.
2. `npx tsx --tsconfig tsconfig.web.json scripts/generateProfileVectors.ts`
3. Review the vectors diff — that diff *is* the rule change, and it is what the Android side has to
   follow.
