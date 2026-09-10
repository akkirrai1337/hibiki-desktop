import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { seasonOf, type ExternalMetadata } from "@shared/externalMetadata";
import { hibiki } from "@/lib/hibiki";
import { HERO_ACTION_CLASS, HeroCarousel, type HeroSlide } from "@/components/Hero";
import { EntryCard } from "@/components/AggregatorCatalog";
import { PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";

const HERO_SLIDE_COUNT = 5;
const ROW_LIMIT = 12;

/**
 * The home screen, built from the aggregator instead of from the source (see
 * docs/aggregator-first-catalog.md).
 *
 * Continue-watching is supplied by home.tsx as `children`: it is about episodes already started,
 * so it keeps the source's own titles/progress, but is inserted after the aggregator hero and
 * before its catalog rows. Every aggregator card leads to the resolution screen rather than to a
 * source title page.
 */
export function AggregatorHome({ sourceId, children }: { sourceId: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const season = seasonOf(new Date());

  const trending = useQuery({
    queryKey: ["aggregatorHome", sourceId, "trending"],
    queryFn: () => hibiki.metadata.browse(sourceId, { mode: "trending", offset: 0, limit: HERO_SLIDE_COUNT + ROW_LIMIT }),
  });
  const seasonal = useQuery({
    queryKey: ["aggregatorHome", sourceId, "season"],
    queryFn: () => hibiki.metadata.browse(sourceId, { mode: "season", offset: 0, limit: ROW_LIMIT }),
  });

  const trendingEntries = trending.data?.results ?? [];
  // The first few carry the carousel and the rest fill the row below it, so the same request serves
  // both and the screen does not show one title twice.
  const heroEntries = trendingEntries.slice(0, HERO_SLIDE_COUNT);
  const rowEntries = trendingEntries.slice(HERO_SLIDE_COUNT);

  return (
    <>
      {trending.isPending ? (
        <HeroPlaceholder />
      ) : (
        heroEntries.length > 0 && (
          <HeroCarousel
            slides={heroEntries.map((entry) => toHeroSlide(entry, t("catalog.openTitle")))}
            label={t("catalogPage.aggregator.trending")}
          />
        )
      )}
      {children}
      <div className="space-y-12 px-8 pt-10">
        <Row title={t("catalogPage.aggregator.trending")}>
          {trending.isPending ? <PosterGridSkeleton count={ROW_LIMIT} /> : <EntryGrid entries={rowEntries} />}
        </Row>
        <Row title={t("catalogPage.aggregator.seasonOf", { season: t(`catalogPage.aggregator.seasons.${season.season}`), year: season.year })}>
          {seasonal.isPending ? <PosterGridSkeleton count={ROW_LIMIT} /> : <EntryGrid entries={seasonal.data?.results ?? []} />}
        </Row>
      </div>
    </>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-[-.02em] text-text">{title}</h2>
        <Link to="/catalog" search={{ sort: "popularity" }} className="text-sm font-semibold text-muted transition-colors hover:text-accent-text">
          {t("catalog.openCatalog")} →
        </Link>
      </div>
      {children}
    </section>
  );
}

function EntryGrid({ entries }: { entries: ExternalMetadata[] }) {
  const { t } = useTranslation();
  if (entries.length === 0) return <p className="text-sm text-muted">{t("catalogPage.aggregator.unavailable")}</p>;
  return (
    <PosterGrid>
      {entries.map((entry) => <EntryCard key={`${entry.provider}:${entry.externalId}`} entry={entry} />)}
    </PosterGrid>
  );
}

function toHeroSlide(entry: ExternalMetadata, openLabel: string): HeroSlide {
  return {
    key: `${entry.provider}:${entry.externalId}`,
    title: entry.englishName ?? entry.romajiName ?? entry.nativeName ?? `#${entry.externalId}`,
    description: entry.description,
    posterUrl: entry.posterUrl,
    type: entry.type,
    year: entry.year,
    episodeCount: entry.episodeCount,
    action: (
      <Link
        to="/entry/$provider/$externalId"
        params={{ provider: entry.provider, externalId: String(entry.externalId) }}
        className={HERO_ACTION_CLASS}
      >
        <Play className="h-4 w-4 fill-current" strokeWidth={0} />
        {openLabel}
      </Link>
    ),
  };
}

function HeroPlaceholder() {
  return <div className="h-[420px] animate-pulse border-b border-white/[.04] bg-text/[.04]" />;
}
