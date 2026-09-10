/** One run of a comment's text: either plain words, or a mention of a user. */
export type CommentPart = { type: "text"; value: string } | { type: "mention"; name: string };

// The site's own markup for "replying to": its editor writes it, its API returns it verbatim, and
// only its web client ever turned it back into a name. Left as raw brackets it was the first thing
// the eye landed on in a thread ("[ник]Rus921k[/ник] самое интересное уже прошло").
const MENTION = /\[ник\]([^[]+)\[\/ник\]/g;

/**
 * Splits a comment into text and the mentions inside it.
 *
 * Deliberately not a general markup parser: this is the one tag YummyAnime actually emits, and a
 * tag this app does not know must be left exactly as written rather than half-interpreted.
 */
export function splitMentions(text: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let index = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > index) parts.push({ type: "text", value: text.slice(index, match.index) });
    parts.push({ type: "mention", name: match[1] });
    index = match.index + match[0].length;
  }
  if (index < text.length) parts.push({ type: "text", value: text.slice(index) });
  return parts;
}
