import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "@shared/ipc";
import type { DownloadProgress, DownloadRequest, PlayerLink } from "@shared/types";
import type { ExtensionRuntime } from "../extensions/runtime";
import {
  cacheAnime,
  cachePlaybackGroups,
  deleteDownloadedEpisodeRow,
  getDownloadedEpisode,
  listDownloadedEpisodes,
  recordDownloadedEpisode,
} from "../offlineCache";

export const DOWNLOADS_DIR = path.join(app.getPath("userData"), "downloads");

// Same ordering as the watch page's own selectPlayerLink (see the route file) - a direct,
// playable link over a third-party embed page, since only the former can actually be fetched and
// saved to disk from here.
const LINK_TYPE_PRIORITY: Record<string, number> = { DIRECT_HLS: 0, DIRECT_MP4: 0, DIRECT_DASH: 1, EMBED: 2 };

function selectPlayerLink(links: PlayerLink[], preferredQuality?: string | null): PlayerLink | undefined {
  if (links.length === 0) return undefined;
  const sorted = [...links].sort((a, b) => (LINK_TYPE_PRIORITY[a.type] ?? 0) - (LINK_TYPE_PRIORITY[b.type] ?? 0));
  // Only ever a preference, not a hard requirement - a quality the picker offered when the dialog
  // was open (e.g. a source whose availability shifts between requests) not being present in this
  // fetch just falls back to the same type-priority pick as if nothing had been requested.
  if (preferredQuality) {
    const match = sorted.find((l) => l.quality === preferredQuality);
    if (match) return match;
  }
  return sorted[0];
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// One entry per episode with a download that's running *or paused* - a paused download keeps its
// entry (and its partial file) around so resume can pick up where it left off; only an explicit
// cancel removes it. `controller` is per attempt, not per download: pausing aborts the current one
// but the episode's entry (and its resume point below) survives for the next `controller` a resume
// creates.
interface DownloadState {
  request: DownloadRequest;
  runtime: ExtensionRuntime;
  link: PlayerLink;
  outFile: string;
  controller: AbortController;
  cancelled: boolean;
  // True only while a fetch for this download is actually in flight - a cancel that arrives while
  // paused (nothing in flight) has nothing for `controller.abort()` to interrupt, so it needs to
  // know to do the cleanup itself instead of relying on runDownload's catch block to get triggered.
  running: boolean;
  // HLS resume point - the segment list only needs resolving once, then this just tracks how far
  // through it the file on disk already goes.
  segmentUris?: string[];
  playlistUrl?: string;
  nextSegmentIndex: number;
  // Summed from the playlist's own #EXTINF values the moment it's resolved - the real total
  // duration, for the synthetic single-file HLS playlist the watch page wraps a downloaded .ts in
  // to play it back (see localFileLink in the watch route) instead of a made-up placeholder.
  durationMs?: number;
  // DIRECT_MP4 resume point.
  bytesReceived: number;
  // The last percent reported to the renderer - carried over into a "paused" status so the chip
  // keeps showing where it actually left off instead of resetting to 0 until the next real
  // progress tick arrives after resuming.
  lastPercent: number;
}

const downloads = new Map<string, DownloadState>();

async function fetchText(url: string, headers: Record<string, string> | null | undefined, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: headers ?? undefined, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Resolves a master playlist down to a single media playlist by taking its first listed variant
 * - a direct PlayerLink's own `quality` was already picked upstream, so this only exists to unwrap
 * the occasional source that still hands back a master playlist instead of the final media one. */
async function resolveMediaPlaylist(url: string, headers: Record<string, string> | null | undefined, signal: AbortSignal): Promise<{ url: string; text: string }> {
  let currentUrl = url;
  let text = await fetchText(currentUrl, headers, signal);
  if (text.includes("#EXT-X-STREAM-INF")) {
    const variantLine = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!variantLine) throw new Error("empty master playlist");
    currentUrl = new URL(variantLine, currentUrl).toString();
    text = await fetchText(currentUrl, headers, signal);
  }
  return { url: currentUrl, text };
}

/** Downloads whatever's left of an HLS media playlist (from `state.nextSegmentIndex` on - 0 for a
 * fresh start, wherever a previous pause left off otherwise) and appends each segment's raw bytes
 * to the output file - segments are MPEG-TS, which (unlike, say, raw H.264 NAL units) is a
 * container format designed to be concatenable, so the result plays back fine in VLC/most players
 * without needing an ffmpeg remux this app doesn't bundle. AES-encrypted streams aren't supported
 * (no key exchange/decryption here), nor is a separate audio track (`audioUrl`) - both surface as
 * a plain thrown error, which the caller reports back as a failed download rather than silently
 * producing a video-only or undecodable file. */
async function downloadHls(state: DownloadState, onProgress: (percent: number) => void): Promise<void> {
  const { link, controller } = state;
  if (link.audioUrl) throw new Error("a separate audio track isn't supported");
  if (!state.segmentUris) {
    const { url: playlistUrl, text } = await resolveMediaPlaylist(link.url, link.headers, controller.signal);
    if (/#EXT-X-KEY:METHOD=(?!NONE)/i.test(text)) throw new Error("an encrypted stream isn't supported");
    const segmentUris: string[] = [];
    let durationSeconds = 0;
    let pendingExtinf = 0;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      const extinf = /^#EXTINF:([\d.]+)/.exec(line);
      if (extinf) {
        pendingExtinf = Number(extinf[1]);
        continue;
      }
      if (!line || line.startsWith("#")) continue;
      segmentUris.push(line);
      durationSeconds += pendingExtinf;
      pendingExtinf = 0;
    }
    if (segmentUris.length === 0) throw new Error("the playlist has no segments");
    state.segmentUris = segmentUris;
    state.playlistUrl = playlistUrl;
    // #EXTINF is mandatory per segment in the HLS spec, so this is normally an exact total: only
    // left unset (falling back to the watch page's own placeholder) if the playlist is malformed
    // enough to have none of them at all.
    if (durationSeconds > 0) state.durationMs = Math.round(durationSeconds * 1000);
  }
  const { segmentUris, playlistUrl } = state as Required<Pick<DownloadState, "segmentUris" | "playlistUrl">>;

  const out = createWriteStream(state.outFile, { flags: state.nextSegmentIndex > 0 ? "a" : "w" });
  try {
    for (let i = state.nextSegmentIndex; i < segmentUris.length; i++) {
      const segmentUrl = new URL(segmentUris[i], playlistUrl).toString();
      const res = await fetch(segmentUrl, { headers: link.headers ?? undefined, signal: controller.signal });
      if (!res.ok) throw new Error(`segment ${i + 1}/${segmentUris.length}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await new Promise<void>((resolve, reject) => out.write(buf, (err) => (err ? reject(err) : resolve())));
      state.nextSegmentIndex = i + 1;
      onProgress(Math.round((state.nextSegmentIndex / segmentUris.length) * 100));
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

/** A plain progressive download (DIRECT_MP4), resumed via an HTTP Range request when
 * `state.bytesReceived > 0`. If the server doesn't actually honor the range (some don't, and just
 * send the whole file back with a 200 instead of a 206 Partial Content), this falls back to
 * restarting the file from scratch rather than corrupting it by appending a *second* full copy
 * onto what's already there. */
async function downloadDirect(state: DownloadState, onProgress: (percent: number) => void): Promise<void> {
  const { link, controller } = state;
  const resuming = state.bytesReceived > 0;
  const headers = { ...(link.headers ?? {}), ...(resuming ? { Range: `bytes=${state.bytesReceived}-` } : {}) };
  const res = await fetch(link.url, { headers, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const rangeHonored = res.status === 206;
  if (resuming && !rangeHonored) state.bytesReceived = 0;

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  const total = rangeHonored ? state.bytesReceived + contentLength : contentLength;
  const out = createWriteStream(state.outFile, { flags: resuming && rangeHonored ? "a" : "w" });
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      state.bytesReceived += value.byteLength;
      await new Promise<void>((resolve, reject) => out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())));
      if (total > 0) onProgress(Math.round((state.bytesReceived / total) * 100));
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
    reader.releaseLock();
  }
}

/** Everything a downloaded episode's title page needs to still work offline: the episode row
 * itself, plus (best-effort - a hiccup here shouldn't fail a download that otherwise completed
 * fine) a snapshot of the anime's own detail and its playback groups, for whenever the source
 * itself isn't reachable later (see sources.ts's own fallback-to-cache). */
async function cacheForOffline(state: DownloadState): Promise<void> {
  const { sourceId, animeId, groupId, episodeId, episodeNumber, episodeLabel } = state.request;
  try {
    const fileStat = await fs.stat(state.outFile);
    recordDownloadedEpisode({ sourceId, animeId, groupId, episodeId, episodeNumber, episodeLabel, filePath: state.outFile, fileSizeBytes: fileStat.size, durationMs: state.durationMs ?? null, quality: state.link.quality ?? null });
    const [anime, groups] = await Promise.all([state.runtime.getById(sourceId, animeId), state.runtime.getPlaybackGroups(sourceId, animeId)]);
    cacheAnime(sourceId, animeId, anime);
    cachePlaybackGroups(sourceId, animeId, groups);
  } catch {
    // Downloaded fine either way - offline browsing for this title just won't have a description/
    // episode list ready until the next successful (online) visit happens to cache it instead.
  }
}

async function runDownload(state: DownloadState, send: (progress: DownloadProgress) => void): Promise<void> {
  const episodeId = state.request.episodeId;
  state.running = true;
  try {
    send({ episodeId, status: "downloading", percent: state.lastPercent });
    const onProgress = (percent: number) => {
      state.lastPercent = percent;
      send({ episodeId, status: "downloading", percent });
    };
    if (state.link.type === "DIRECT_HLS") await downloadHls(state, onProgress);
    else await downloadDirect(state, onProgress);

    downloads.delete(episodeId);
    await cacheForOffline(state);
    send({ episodeId, status: "done", filePath: state.outFile });
  } catch (err) {
    if (!isAbortError(err)) {
      downloads.delete(episodeId);
      send({ episodeId, status: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (state.cancelled) {
      downloads.delete(episodeId);
      // A half-written file left behind by a cancelled download isn't useful to anyone - clean it
      // up rather than leaving a truncated video sitting in the downloads folder.
      await fs.rm(state.outFile, { force: true }).catch(() => {});
      send({ episodeId, status: "cancelled" });
    } else {
      // Just paused - the entry (and the partial file on disk) stays put for resume to continue.
      // `percent: state.lastPercent` so the chip keeps showing where it actually left off instead
      // of resetting to 0 (DownloadProgress.percent just wouldn't be there at all otherwise).
      send({ episodeId, status: "paused", percent: state.lastPercent });
    }
  } finally {
    state.running = false;
  }
}

async function resolveAndRunDownload(runtime: ExtensionRuntime, request: DownloadRequest, send: (progress: DownloadProgress) => void): Promise<void> {
  // Wrapped in its own try/catch (distinct from runDownload's) since this part - resolving the
  // link, making the anime's folder - has no AbortController/state of its own yet to report
  // through consistently, and this now runs from inside pumpQueue's fire-and-forget dispatch,
  // where an uncaught rejection here would otherwise surface as an unhandled promise rejection
  // instead of a normal "error" status on the episode's own card.
  try {
    const links = await runtime.getPlayerLinks(request.sourceId, request.animeId, request.groupId, request.episodeId);
    const link = selectPlayerLink(links, request.quality);
    if (!link || link.type === "EMBED" || link.type === "DIRECT_DASH" || link.audioUrl) {
      send({ episodeId: request.episodeId, status: "unsupported" });
      return;
    }

    const animeDir = path.join(DOWNLOADS_DIR, sanitizeFilename(request.animeTitle));
    await fs.mkdir(animeDir, { recursive: true });
    const ext = link.type === "DIRECT_MP4" ? "mp4" : "ts";
    const outFile = path.join(animeDir, `${sanitizeFilename(request.episodeLabel)}.${ext}`);

    const state: DownloadState = { request, runtime, link, outFile, controller: new AbortController(), cancelled: false, running: false, nextSegmentIndex: 0, bytesReceived: 0, lastPercent: 0 };
    downloads.set(request.episodeId, state);
    await runDownload(state, send);
  } catch (err) {
    send({ episodeId: request.episodeId, status: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

// At most this many transfers actually run at once - queuing the rest instead of firing off
// everything a user selects at once keeps a "download all 10" from saturating bandwidth/disk I/O
// (and hammering the source with that many simultaneous getPlayerLinks + segment requests) the
// same way one download at a time never did.
const MAX_CONCURRENT_DOWNLOADS = 2;
let activeCount = 0;
// A queued job is either a fresh download (still needs its link resolved - that happens lazily,
// right when it's actually dequeued, not up front for the whole batch at once) or a paused one
// waiting for a slot to resume into - both go through the same slot-limited pipe.
type QueuedJob = { kind: "start"; request: DownloadRequest } | { kind: "resume"; episodeId: string };
const jobQueue: QueuedJob[] = [];

function jobEpisodeId(job: QueuedJob): string {
  return job.kind === "start" ? job.request.episodeId : job.episodeId;
}

function pumpQueue(runtime: ExtensionRuntime, send: (progress: DownloadProgress) => void): void {
  while (activeCount < MAX_CONCURRENT_DOWNLOADS && jobQueue.length > 0) {
    const job = jobQueue.shift()!;
    activeCount++;
    const settle = () => {
      activeCount--;
      pumpQueue(runtime, send);
    };
    if (job.kind === "start") {
      resolveAndRunDownload(runtime, job.request, send).finally(settle);
    } else {
      const state = downloads.get(job.episodeId);
      if (!state) {
        settle();
        continue;
      }
      state.controller = new AbortController();
      runDownload(state, send).finally(settle);
    }
  }
}

function enqueueStart(runtime: ExtensionRuntime, request: DownloadRequest, send: (progress: DownloadProgress) => void): void {
  if (downloads.has(request.episodeId) || jobQueue.some((j) => jobEpisodeId(j) === request.episodeId)) return;
  jobQueue.push({ kind: "start", request });
  send({ episodeId: request.episodeId, status: "queued" });
  pumpQueue(runtime, send);
}

function enqueueResume(runtime: ExtensionRuntime, episodeId: string, send: (progress: DownloadProgress) => void): void {
  const state = downloads.get(episodeId);
  if (!state || state.running || jobQueue.some((j) => jobEpisodeId(j) === episodeId)) return;
  jobQueue.push({ kind: "resume", episodeId });
  send({ episodeId, status: "queued", percent: state.lastPercent });
  pumpQueue(runtime, send);
}

export function registerDownloadHandlers(runtime: ExtensionRuntime, getWindow: () => BrowserWindow | null): void {
  const send = (progress: DownloadProgress) => getWindow()?.webContents.send(IPC.downloadsProgress, progress);

  // Not awaited on purpose - a download can run for a while (potentially hundreds of HLS segment
  // requests), and the renderer only needs this call to *start* the job, not block on its
  // completion. Progress (including the final done/error/paused/cancelled) arrives separately via
  // downloadsProgress.
  ipcMain.handle(IPC.downloadsStart, (_e, request: DownloadRequest) => {
    enqueueStart(runtime, request, send);
  });
  ipcMain.handle(IPC.downloadsPause, (_e, episodeId: string) => {
    // Aborting is what actually stops the in-flight request - `runDownload`'s catch block sees
    // that abort, notices `cancelled` is still false, and reports "paused" instead of tearing the
    // entry down, leaving it ready to resume into later. The freed slot (via the `.finally` in
    // pumpQueue, once the abort actually unwinds runDownload) lets the next queued job start.
    downloads.get(episodeId)?.controller.abort();
  });
  ipcMain.handle(IPC.downloadsResume, (_e, episodeId: string) => {
    enqueueResume(runtime, episodeId, send);
  });
  ipcMain.handle(IPC.downloadsCancel, async (_e, episodeId: string) => {
    // Still just waiting in line, never actually started - nothing for an abort to interrupt, so
    // this is the one case cancel doesn't go through runDownload's own cleanup path at all.
    const queuedIndex = jobQueue.findIndex((j) => jobEpisodeId(j) === episodeId);
    if (queuedIndex !== -1) {
      jobQueue.splice(queuedIndex, 1);
      const state = downloads.get(episodeId);
      downloads.delete(episodeId);
      if (state) await fs.rm(state.outFile, { force: true }).catch(() => {});
      send({ episodeId, status: "cancelled" });
      return;
    }
    const state = downloads.get(episodeId);
    if (!state) return;
    state.cancelled = true;
    if (state.running) {
      // The abort below is what triggers the actual cleanup, via runDownload's catch block.
      state.controller.abort();
      return;
    }
    // Nothing's in flight (the download is currently paused) - there's no fetch for abort() to
    // interrupt, and so nothing that would otherwise reach runDownload's catch block to do the
    // cleanup. Do it here instead.
    downloads.delete(episodeId);
    await fs.rm(state.outFile, { force: true }).catch(() => {});
    send({ episodeId, status: "cancelled" });
  });
  ipcMain.handle(IPC.downloadsList, () => listDownloadedEpisodes());
  ipcMain.handle(IPC.downloadsGetForEpisode, (_e, sourceId: string, animeId: string, episodeId: string) =>
    getDownloadedEpisode(sourceId, animeId, episodeId),
  );
  ipcMain.handle(IPC.downloadsRemove, async (_e, sourceId: string, animeId: string, episodeId: string) => {
    const row = getDownloadedEpisode(sourceId, animeId, episodeId);
    deleteDownloadedEpisodeRow(sourceId, animeId, episodeId);
    if (row) await fs.rm(row.filePath, { force: true }).catch(() => {});
  });
}
