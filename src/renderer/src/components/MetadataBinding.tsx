import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { metadataEntryUrl, PROVIDER_RATING_SOURCE } from "@shared/externalMetadata";
import { hibiki } from "@/lib/hibiki";
import { useUiStore } from "@/stores/uiStore";

/** Read-only attribution for the external metadata shown on a title page. */
export function MetadataBinding({ sourceId, animeId, titleLoadedAt }: { sourceId: string; animeId: string; titleLoadedAt: number }) {
  const { t } = useTranslation();
  const shown = useUiStore((state) => state.externalMetadataShowBinding);
  // The match is made by the title fetch, so its arrival time belongs in the key. Otherwise a
  // parallel request may cache "not matched" just before that fetch finishes matching it.
  const binding = useQuery({
    queryKey: ["metadataMatch", sourceId, animeId, titleLoadedAt],
    queryFn: () => hibiki.metadata.match(sourceId, animeId),
    enabled: shown && titleLoadedAt > 0,
  });

  if (!shown || !binding.data || binding.data.providers.length === 0) return null;
  const match = binding.data.match;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
      <div className="inline-flex items-center gap-2 px-1.5 py-1">
        <Globe className="h-3.5 w-3.5" strokeWidth={2} />
        {match ? (
          <span>
            {t("detail.metadata.describedBy", { provider: PROVIDER_RATING_SOURCE[match.provider] })}
            {match.manual
              ? ` · ${t("detail.metadata.manual")}`
              : match.confidence != null
                ? ` · ${t("detail.metadata.confidence", { percent: match.confidence })}`
                : ""}
            {` · #${match.externalId}`}
          </span>
        ) : (
          <span>{t("detail.metadata.notMatched")}</span>
        )}
      </div>
      {match && (
        <a
          href={metadataEntryUrl(match.provider, match.externalId)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center transition-colors hover:text-text"
          title={metadataEntryUrl(match.provider, match.externalId)}
        >
          <ExternalLink className="h-3 w-3" strokeWidth={2.5} />
        </a>
      )}
    </div>
  );
}
