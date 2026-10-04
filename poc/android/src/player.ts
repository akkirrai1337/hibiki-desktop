// Plan item 0.3: play a stream that needs request headers (Referer/User-Agent) through the native
// proxy at https://localhost/_hibiki/stream?sid=<session>&u=<upstream url>.
import Hls, { type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from "hls.js";
import { HibikiNet, isNative } from "./native";

const PROXY_PATH = "/_hibiki/stream";

export function proxify(sid: string, url: string): string {
  return `${PROXY_PATH}?sid=${encodeURIComponent(sid)}&u=${encodeURIComponent(url)}`;
}

let activeHls: Hls | null = null;

export async function play(
  video: HTMLVideoElement,
  url: string,
  headers: Record<string, string>,
  kind: "hls" | "mp4",
  log: (line: string) => void,
): Promise<void> {
  activeHls?.destroy();
  activeHls = null;
  video.removeAttribute("src");

  if (!isNative) {
    log("player: not native, playing without the proxy (headers ignored)");
  }
  const sid = isNative ? (await HibikiNet.registerStream({ headers })).sid : "";
  const wrap = (target: string) => (isNative ? proxify(sid, target) : target);

  if (kind === "mp4" || !Hls.isSupported()) {
    video.src = wrap(url);
    await video.play().catch((error: unknown) => log(`player: play() rejected: ${String(error)}`));
    return;
  }

  // hls.js resolves relative playlist/segment URLs against response.url. Every request goes to the
  // proxy, but the response is reported back under its *upstream* URL (the final one after
  // redirects, sent by the proxy as X-Hibiki-Final-Url) so that resolution keeps working.
  const BaseLoader = Hls.DefaultConfig.loader;
  class ProxyLoader extends BaseLoader {
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      const upstream = context.url;
      context.url = wrap(upstream);
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          const xhr = networkDetails as XMLHttpRequest | undefined;
          const finalUrl = xhr?.getResponseHeader?.("X-Hibiki-Final-Url") || upstream;
          response.url = finalUrl;
          ctx.url = upstream;
          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
      });
    }
  }

  const hls = new Hls({ loader: ProxyLoader });
  activeHls = hls;
  hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => log(`player: manifest parsed, ${data.levels.length} levels`));
  hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    if (data.frag.sn === 0 || data.frag.sn === 1) log(`player: fragment ${data.frag.sn} loaded (${data.frag.url})`);
  });
  hls.on(Hls.Events.ERROR, (_event, data) => log(`player: ${data.fatal ? "FATAL " : ""}${data.type}/${data.details} ${data.response?.code ?? ""}`));
  hls.loadSource(url);
  hls.attachMedia(video);
  await video.play().catch(() => undefined);
}
