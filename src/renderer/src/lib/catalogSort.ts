import type { TFunction } from "i18next";
import type { SearchFilterOption } from "@shared/types";

const keyOf = (value: string) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");

/**
 * A sort order's label. The source picks the id and title; the client only dresses them up: a known
 * word ("rating_counters", "relevance") gets a proper localized name, anything else keeps the
 * source's own title, capitalised.
 */
export function sortLabel(option: SearchFilterOption, t: TFunction): string {
  for (const key of [keyOf(option.id), keyOf(option.title)]) {
    if (key && !key.includes(".")) {
      const name = t(`catalogPage.sort.names.${key}`, { defaultValue: "" });
      if (name) return name;
    }
  }
  const title = option.title.replace(/[_-]+/g, " ").trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Which of a source's own orders suits "the best-known titles" - the hero and the popular row of the
// home page. Matched on words in the id or title, since what the source calls it is up to the source.
const POPULAR_WORDS = /rating|score|popular|trend|views|viewed|top|оцен|рейтинг|популяр|просмотр|перегляд|рейтинг/i;

export function pickPopularSort(options: SearchFilterOption[]): string | undefined {
  return (options.find((o) => /popular|views|viewed|просмотр|популяр|перегляд/i.test(`${o.id} ${o.title}`)) ?? options.find((o) => POPULAR_WORDS.test(`${o.id} ${o.title}`)))?.id;
}
