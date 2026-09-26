import type { SearchFilterOption } from "@shared/types";

/** A sort order's label: whatever the source called it. */
export const sortLabel = (option: SearchFilterOption): string => option.title;

// Which of a source's own orders suits "the best-known titles" - the hero and the popular row of the
// home page. Matched on words in the id or title, since what the source calls it is up to the source.
const POPULAR_WORDS = /rating|score|popular|trend|views|viewed|top|оцен|рейтинг|популяр|просмотр|перегляд|рейтинг/i;

export function pickPopularSort(options: SearchFilterOption[]): string | undefined {
  return (options.find((o) => /popular|views|viewed|просмотр|популяр|перегляд/i.test(`${o.id} ${o.title}`)) ?? options.find((o) => POPULAR_WORDS.test(`${o.id} ${o.title}`)))?.id;
}
