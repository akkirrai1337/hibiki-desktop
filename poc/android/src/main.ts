// Phase 0 test bench. Every check from docs/android-port-plan.md §2 has a button here, and the log
// at the bottom is meant to be copied back into the conversation as-is.
import { acquireChallenge, netFetch, runExtensionCall, type CallOutcome } from "./extensionHost";
import { HibikiBrowser, isNative } from "./native";
import { play } from "./player";
import type { Transport } from "./protocol";

type Manifest = { id: string; name: string; hosts?: string[]; runtime?: string };

const manifestModules = import.meta.glob<Manifest>("../../../../hibiki-sources/extensions/**/*.manifest.json", {
  eager: true,
  import: "default",
});
const scriptModules = import.meta.glob<string>("../../../../hibiki-sources/extensions/**/*.js", {
  query: "?raw",
  import: "default",
});

const sources: Manifest[] = [];
const extractors: Manifest[] = [];
const scriptLoaders = new Map<string, () => Promise<string>>();
for (const [path, manifest] of Object.entries(manifestModules)) {
  const scriptPath = path.replace(/\.manifest\.json$/, ".js");
  const loader = scriptModules[scriptPath];
  if (!loader) continue;
  scriptLoaders.set(manifest.id, loader);
  (path.includes("/extractors/") ? extractors : sources).push(manifest);
}
sources.sort((a, b) => a.name.localeCompare(b.name));

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h2>0.1 Environment</h2>
  <section><pre id="env"></pre>
    <label>Bridge transport</label>
    <select id="transport"><option value="sab">sab (SharedArrayBuffer + Atomics)</option><option value="xhr">xhr (sync XHR held by native)</option></select>
  </section>

  <h2>0.2 Extension calls</h2>
  <section>
    <label>Source</label><select id="source"></select>
    <label>Search query</label><input id="query" value="naruto" />
    <div class="row">
      <div><label>Title id</label><input id="titleId" /></div>
      <div><label>Group id</label><input id="groupId" /></div>
      <div><label>Episode id</label><input id="episodeId" /></div>
    </div>
    <button id="runAll">Run chain</button>
    <button class="secondary" data-m="latest">latest</button>
    <button class="secondary" data-m="search">search</button>
    <button class="secondary" data-m="getById">getById</button>
    <button class="secondary" data-m="getPlaybackGroups">groups</button>
    <button class="secondary" data-m="getPlayerLinks">links</button>
    <button class="secondary" id="resolve">resolve first EMBED</button>
    <pre id="result"></pre>
  </section>

  <h2>0.3 Player through native proxy</h2>
  <section>
    <label>Stream URL</label><input id="streamUrl" />
    <label>Headers (JSON)</label><textarea id="streamHeaders">{}</textarea>
    <select id="streamKind"><option value="hls">HLS</option><option value="mp4">MP4</option></select>
    <button id="play">Play</button>
    <video id="video" controls playsinline></video>
  </section>

  <h2>0.4 Challenge in hidden WebView</h2>
  <section>
    <label>URL</label><input id="challengeUrl" placeholder="https://site-behind-cloudflare/" />
    <label>Required cookie names (comma separated)</label><input id="challengeCookies" value="cf_clearance" />
    <button id="challenge">Solve + refetch</button>
  </section>

  <h2>Log</h2>
  <section><button class="secondary" id="copyLog">Copy log</button><button class="secondary" id="clearLog">Clear</button><pre id="log"></pre></section>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>("log");
function log(line: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  logEl.textContent = `${stamp} ${line}\n${logEl.textContent ?? ""}`.slice(0, 60_000);
  console.log(line);
}

// --- 0.1 -------------------------------------------------------------------------------------
async function describeEnvironment(): Promise<void> {
  let growable = false;
  try {
    growable = new SharedArrayBuffer(8, { maxByteLength: 16 }).growable === true;
  } catch {
    growable = false;
  }
  const lines = [
    `native: ${isNative}`,
    `crossOriginIsolated: ${self.crossOriginIsolated}`,
    `SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined"}`,
    `growable SAB: ${growable}`,
    `Atomics.wait: ${typeof Atomics?.wait === "function"}`,
    `navigator.userAgent: ${navigator.userAgent}`,
  ];
  if (isNative) {
    try {
      lines.push(`WebView default UA: ${(await HibikiBrowser.userAgent()).value}`);
    } catch (error) {
      lines.push(`WebView default UA: failed (${String(error)})`);
    }
  }
  $("env").textContent = lines.join("\n");
  lines.forEach((line) => log(`env ${line}`));
  if (!self.crossOriginIsolated) $<HTMLSelectElement>("transport").value = "xhr";
}

// --- 0.2 -------------------------------------------------------------------------------------
const sourceSelect = $<HTMLSelectElement>("source");
sourceSelect.innerHTML = sources.map((s) => `<option value="${s.id}">${s.name} (${s.id})</option>`).join("");
sourceSelect.value = sources.some((s) => s.id === "animego") ? "animego" : sources[0]?.id ?? "";

let lastLinks: Array<{ url: string; type: string; headers?: Record<string, string> | null }> = [];

function summarize(method: string, outcome: CallOutcome): string {
  const head = `${method}: ${outcome.ok ? "OK" : "FAIL"} in ${Math.round(outcome.ms)}ms (bridge calls ${outcome.bridgeCalls}, ${Math.round(outcome.bridgeMs)}ms)`;
  if (!outcome.ok) return `${head}\n${outcome.error}`;
  const value = outcome.value;
  const count = Array.isArray(value) ? `, ${value.length} items` : "";
  return `${head}${count}\n${JSON.stringify(value, null, 1).slice(0, 4000)}`;
}

async function call(method: string, args: unknown[], sourceId = sourceSelect.value): Promise<CallOutcome> {
  const loader = scriptLoaders.get(sourceId);
  if (!loader) throw new Error(`no script for ${sourceId}`);
  const script = await loader();
  const transport = $<HTMLSelectElement>("transport").value as Transport;
  log(`call ${sourceId}.${method}(${JSON.stringify(args).slice(0, 120)}) via ${transport}`);
  const outcome = await runExtensionCall({ sourceId, script, method, args }, transport, log);
  const text = summarize(`${sourceId}.${method}`, outcome);
  $("result").textContent = text;
  log(text.split("\n")[0] + (outcome.ok ? "" : ` - ${outcome.error}`));
  autofill(method, outcome);
  return outcome;
}

function autofill(method: string, outcome: CallOutcome): void {
  if (!outcome.ok) return;
  const value = outcome.value as never;
  if ((method === "latest" || method === "search") && Array.isArray(value) && value[0]) {
    $<HTMLInputElement>("titleId").value = (value[0] as { id: string }).id;
  }
  if (method === "getPlaybackGroups" && Array.isArray(value) && value[0]) {
    const group = value[0] as { id: string; episodes?: Array<{ id: string }> };
    $<HTMLInputElement>("groupId").value = group.id;
    if (group.episodes?.[0]) $<HTMLInputElement>("episodeId").value = group.episodes[0].id;
  }
  if ((method === "getPlayerLinks" || method === "resolve") && Array.isArray(value)) {
    if (method === "getPlayerLinks") lastLinks = value;
    // Resolvers answer with bare HLS/MP4/DASH; desktop's runtime.ts maps those to DIRECT_* afterwards.
    const direct = (value as typeof lastLinks).find((link) => isDirect(link.type));
    if (direct) fillPlayer(direct);
  }
}

function fillPlayer(link: { url: string; type: string; headers?: Record<string, string> | null }): void {
  $<HTMLInputElement>("streamUrl").value = link.url;
  $<HTMLTextAreaElement>("streamHeaders").value = JSON.stringify(link.headers ?? {}, null, 1);
  $<HTMLSelectElement>("streamKind").value = link.type === "DIRECT_MP4" || link.type === "MP4" ? "mp4" : "hls";
}

function isDirect(type: string): boolean {
  return type.startsWith("DIRECT_") || type === "HLS" || type === "MP4";
}

function args(method: string): unknown[] {
  const titleId = $<HTMLInputElement>("titleId").value;
  switch (method) {
    case "latest":
      return [20];
    case "search":
      return [{ query: $<HTMLInputElement>("query").value, offset: 0, limit: 20, filters: {} }];
    case "getById":
    case "getPlaybackGroups":
      return [titleId];
    case "getPlayerLinks":
      return [titleId, $<HTMLInputElement>("groupId").value, $<HTMLInputElement>("episodeId").value];
    default:
      return [];
  }
}

document.querySelectorAll<HTMLButtonElement>("button[data-m]").forEach((button) => {
  button.onclick = () => void call(button.dataset.m!, args(button.dataset.m!)).catch((e) => log(`error: ${String(e)}`));
});

async function resolveFirstEmbed(): Promise<void> {
  const embed = lastLinks.find((link) => link.type === "EMBED");
  if (!embed) return log("resolve: no EMBED link in the last getPlayerLinks result");
  const host = new URL(embed.url.startsWith("//") ? `https:${embed.url}` : embed.url).hostname;
  const extractor = extractors.find((e) => e.hosts?.some((h) => host === h || host.endsWith(`.${h}`)));
  if (!extractor) return log(`resolve: no extractor for host ${host}`);
  await call("resolve", [JSON.stringify(embed)], extractor.id);
}

$("resolve").onclick = () => void resolveFirstEmbed().catch((e) => log(`error: ${String(e)}`));

$("runAll").onclick = async () => {
  try {
    for (const method of ["latest", "getById", "getPlaybackGroups", "getPlayerLinks"]) {
      const outcome = await call(method, args(method));
      if (!outcome.ok) return;
    }
    if (!lastLinks.some((link) => isDirect(link.type))) await resolveFirstEmbed();
  } catch (error) {
    log(`error: ${String(error)}`);
  }
};

// --- 0.3 -------------------------------------------------------------------------------------
$("play").onclick = () => {
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse($<HTMLTextAreaElement>("streamHeaders").value || "{}");
  } catch {
    return log("player: headers are not valid JSON");
  }
  const kind = $<HTMLSelectElement>("streamKind").value as "hls" | "mp4";
  log(`player: ${kind} ${$<HTMLInputElement>("streamUrl").value} headers=${JSON.stringify(headers)}`);
  void play($<HTMLVideoElement>("video"), $<HTMLInputElement>("streamUrl").value, headers, kind, log);
};
const video = $<HTMLVideoElement>("video");
video.addEventListener("playing", () => log(`player: playing at ${video.currentTime.toFixed(1)}s`));
video.addEventListener("seeked", () => log(`player: seeked to ${video.currentTime.toFixed(1)}s`));
video.addEventListener("error", () => log(`player: media error ${video.error?.code} ${video.error?.message ?? ""}`));

// --- 0.4 -------------------------------------------------------------------------------------
$("challenge").onclick = async () => {
  const url = $<HTMLInputElement>("challengeUrl").value.trim();
  if (!url) return;
  const names = $<HTMLInputElement>("challengeCookies").value.split(",").map((n) => n.trim()).filter(Boolean);
  try {
    const before = await netFetch(url);
    log(`challenge: plain fetch before = HTTP ${before.status}`);
    const session = await acquireChallenge(url, names, true, log);
    log(`challenge: session cookies=[${Object.keys(session.cookies).join(", ")}] ua=${session.userAgent}`);
    const after = await netFetch(url, { headers: { Cookie: session.cookieHeader, "User-Agent": session.userAgent } });
    log(`challenge: refetch with session = HTTP ${after.status} (${after.body.length}b)`);
  } catch (error) {
    log(`challenge: error ${String(error)}`);
  }
};

// --- log -------------------------------------------------------------------------------------
$("copyLog").onclick = () => void navigator.clipboard.writeText(logEl.textContent ?? "").then(() => log("log copied"));
$("clearLog").onclick = () => (logEl.textContent = "");

// On the phone the whole bench runs by itself once on launch and reports through console.log,
// which Capacitor forwards to logcat (tag Capacitor/Console) - no need to drive the UI remotely.
// Which parts of the bench autorun covers; the player and source chain already passed on device
// (see the plan), the challenge is the one still being checked.
const AUTORUN = { chain: false, challengeSources: false };

async function autorun(): Promise<void> {
  await describeEnvironment();
  if (!isNative) return;
  log("autorun: start");
  if (AUTORUN.chain) await autorunChain();
  if (AUTORUN.challengeSources) {
    for (const sourceId of ["animepahe", "anikappa"]) {
      if (!scriptLoaders.has(sourceId)) continue;
      await call("latest", [20], sourceId).catch((e) => log(`error: ${String(e)}`));
    }
  }
  await autorunChallenge();
  log("autorun: done");
}

async function autorunChain(): Promise<void> {
  $("runAll").click();
  // runAll's own promise is not exposed; wait for the chain to settle, then try the player.
  for (let i = 0; i < 120 && !$<HTMLInputElement>("streamUrl").value; i++) await new Promise((r) => setTimeout(r, 500));
  if ($<HTMLInputElement>("streamUrl").value) {
    $("play").click();
    await new Promise((r) => setTimeout(r, 15_000));
    log(`autorun: player state currentTime=${video.currentTime.toFixed(1)} readyState=${video.readyState} paused=${video.paused}`);
    if (video.duration > 120) {
      video.currentTime = video.duration / 2;
      await new Promise((r) => setTimeout(r, 6_000));
      log(`autorun: after seek currentTime=${video.currentTime.toFixed(1)} readyState=${video.readyState}`);
    }
  } else {
    log("autorun: no direct stream found, player skipped");
  }
  video.pause();
}

async function autorunChallenge(): Promise<void> {
  // A page that always answers with a Cloudflare challenge: hidden WebView first, then shown for a
  // person; whatever cf_clearance it earns is replayed through the native client.
  $<HTMLInputElement>("challengeUrl").value = "https://www.scrapingcourse.com/cloudflare-challenge";
  $<HTMLInputElement>("challengeCookies").value = "cf_clearance";
  $("challenge").click();
  for (let i = 0; i < 300 && !/challenge: (refetch|error)/.test(logEl.textContent ?? ""); i++) await new Promise((r) => setTimeout(r, 500));
}

void autorun();
