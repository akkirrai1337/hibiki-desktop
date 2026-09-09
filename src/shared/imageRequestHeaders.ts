/**
 * Posters and source icons are fetched by the renderer, so Chromium attaches this app's own page
 * as their Referer. Sites with hotlink protection read that as theft: AniTube's CDN answers 403 to
 * a foreign Referer while serving the very same file to a request that carries none (verified
 * against anitube.in.ua). The Android app has always loaded posters through a plain HTTP client
 * that sends no Referer, which is why they appear there and not here.
 *
 * So a remote image is asked for the way opening one directly would ask - with no Referer and no
 * Origin. A CDN that insists on its *own* site as the Referer is no worse off than before: it was
 * already being sent this app's origin, which is not that either.
 *
 * Playback traffic never reaches this. A URL with registered playback headers is answered before
 * this is consulted, and those carry the Referer the stream actually requires.
 */
export function headersForImageRequest(
  resourceType: string,
  requestHeaders: Record<string, string>,
): Record<string, string> {
  if (resourceType !== "image") return requestHeaders;
  const kept = Object.entries(requestHeaders).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== "referer" && lower !== "origin";
  });
  if (kept.length === Object.keys(requestHeaders).length) return requestHeaders;
  return Object.fromEntries(kept);
}
