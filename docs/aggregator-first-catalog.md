# Aggregator-first catalog — plan

Browsing moves to the metadata aggregator (Kitsu / AniList / MAL). A source stops being what you
browse and becomes what plays: it is resolved when a title is opened, not before.

This is written against the state after `006e7cf` — providers, matching, the per-title binding and
whole-screen description already exist and are reused as they are.

## Principle: a browsing surface, not a new data model

Storage keys do not change. Library, watch progress, downloaded episodes, history and the offline
cache stay keyed by `(sourceId, animeId)`, and the title page stays the same route it is today.

The aggregator catalog is a surface in front of that: a card names an aggregator entry, and clicking
it resolves that entry to a title of the current source and navigates to the existing page. Nothing
that already works has to be migrated, which removes the one risk that made this look expensive —
library and progress cannot "slide" if nothing about how they are stored moves.

## NSFW sources are out

A source flagged `isNsfw` keeps its own catalog exactly as it is today: its own home, its own
search, its own metadata. The aggregators do not index most of that material, and a catalog that
silently drops half of a source's library is worse than no change at all. The switch is per source
and follows the same `useExternalMetadata` flag that already gates descriptions.

## Reverse resolution: aggregator entry → source title

Four tiers, cheapest first. Only the third costs a request.

1. **A match already recorded.** `external_metadata_matches` maps `(sourceId, animeId, provider)` to
   an entry id. Read backwards — by `(provider, externalId, sourceId)` — it answers "which title of
   this source is this entry" for everything ever opened or described. Anything in the library, in
   history, or on a screen that has been browsed is already in there. This is the common case, and
   it needs an index on `(provider, external_id)`.
2. **A cross-provider id.** The entry carries the other providers' ids (Kitsu publishes both,
   AniList publishes `idMal`), so a title matched through one provider resolves through any of them.
3. **A live search of the source.** Query the source with the entry's romaji and English names, score
   the results with the existing `scoreCandidate`, accept above the existing threshold. Record the
   result as an ordinary match, so it is tier 1 from then on.
4. **The user picks.** A short list of the source's own search results, same shape as the existing
   metadata picker, and the pick is stored as a manual match.

Tier 3 is the weak one, and knowing why matters: a source's search results carry a name and often
nothing else — no synonyms, no year, no type — and those are exactly the fields that separate a
sequel from its first season. Expect a visible failure rate there and treat tier 4 as part of the
normal flow, not an error path.

## When no source has it

The aggregator's catalog contains titles no installed source carries. That state needs to be a real
screen, not a dead end:

- Say plainly that the current source does not have this title.
- Offer the other installed sources that are not NSFW, resolving each on demand.
- Keep the aggregator's own description visible while offering it, so the page is still worth
  landing on.

This is also where multi-source support arrives for free: one aggregator entry can resolve to
several sources, and the same screen picks between them.

## Screens

| Screen | Today | After |
| --- | --- | --- |
| Home | Source search/latest, described | Aggregator trending + seasonal, plus continue-watching (unchanged, source-keyed) |
| Catalog | Source catalog, described | Aggregator catalog with its filters (season, year, genre, format) |
| Search | Source search, described | Aggregator search; a "search this source instead" escape stays |
| Title | Source title, described | Same page, reached through resolution |
| Library / History / Downloads | Source-keyed | Unchanged |

Kitsu covers everything the new Home and Catalog need and is verified working: `/trending/anime`,
`sort=-userCount`, `filter[seasonYear]`, `filter[season]`, `filter[categories]`, `filter[text]`.
AniList covers the same through one GraphQL query when its API returns; MAL via Jikan is the weakest
of the three for browsing (no trending endpoint worth the name) and should stay a description
provider rather than a catalog one.

## Work, in shippable steps

1. **Reverse resolver, no UI.** Tiers 1–3 behind one main-process call plus the index. Verified by
   resolving a handful of known entries against an installed source.
2. **Resolution screen.** The loading state, the "not on this source" state with other sources, and
   the manual picker (tier 4). Reachable from a debug entry point before any catalog uses it.
3. **Aggregator catalog page.** Behind a setting, defaulting off, so the existing catalog stays the
   way back if resolution turns out to be worse than expected.
4. **Aggregator home.** Trending and seasonal rows, continue-watching untouched.
5. **Aggregator search**, with the source-search escape.
6. **Default flip and cleanup**, once the failure rate of step 1 is known from real use.

Steps 3 to 5 are each independently useful and independently revertible, which is the point of the
setting in step 3.

## Open questions

- **Which provider drives the catalog.** Kitsu today, because it is the only one whose search and
  browse endpoints both answer. If AniList returns, its catalog is richer (trending is genuinely
  trending, not a popularity ranking) and it should probably take over, with Kitsu as the fallback.
- **Pagination and rate limits.** A catalog page is one request, which is fine; resolving twelve
  visible cards to source titles is not something to do eagerly. Resolve on click only.
- **What a card shows before resolution.** Nothing about a card says whether the source has it. Either
  accept that, or resolve lazily in the background for the visible page and dim what is missing -
  which costs a source search per card and probably is not worth it.
- **Ordering of the library.** Library entries are source titles described by the aggregator, so they
  already agree with the new catalog. No work expected, but worth checking once the catalog lands.
