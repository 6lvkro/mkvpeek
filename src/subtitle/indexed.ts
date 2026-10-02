import {
  available,
  type IndexFetch,
  type Range,
  type SizedSource,
  type Source,
  stopIfAborted,
  type Watch,
} from "../io/source.js";
import { coalesce, fetchRanges, fetchSpans, WindowIndex } from "../io/windows.js";
import { CLUSTER_PROBE_BYTES } from "../matroska/chain.js";
import {
  agreesWithCluster,
  type ClusterMemo,
  type CuedBlock,
  locateByCue,
  planCuedShortfall,
  planProbes,
  planRanges,
  planShortfall,
  readCuedFrame,
  readFrame,
} from "../matroska/cues.js";
import type { CuePosition, IndexedHeader, TrackEntry } from "../matroska/header.js";
import { isNumbered, statedFrameCount } from "../tracks/subtitle.js";
import type { RefusalCode } from "../vocabulary.js";
import { type Event, eventOf, type Timeline } from "./assemble.js";
import { assembleTrack, planFrom, type ReadPlan, type TrackTexts } from "./conclude.js";

export async function readByIndex(
  source: Source,
  knobs: IndexFetch,
  header: IndexedHeader,
  watch: Watch,
): Promise<TrackTexts | RefusalCode> {
  const plan = planFrom(header);
  if (typeof plan === "string") return plan;
  const collected = await followIndex(source, knobs, header, plan, watch);
  if (!(collected instanceof Map)) return collected;
  const out = new Map<number, string>();
  for (const track of plan.wanted) {
    const events = collected.get(track.number) ?? [];
    const vouched = anchorless(events) ? "may-be-short" : "whole";
    const assembled = assembleTrack(track, events, vouched);
    if (typeof assembled === "string") return assembled;
    out.set(track.index, assembled.text);
  }
  return out;
}

interface PlannedCue {
  track: TrackEntry;
  numbered: boolean;
  cue: CuePosition;
}

interface PlannedRound {
  slice: PlannedCue[];
  spans: Range[];
  bytes: number;
}

interface TrackedEvent {
  track: number;
  event: Event;
}

interface RoundInvariants {
  sized: SizedSource;
  clusterStarts: readonly number[];
  segmentEnd: number;
  knobs: IndexFetch;
  timeline: Timeline;
  head: IndexedHeader["head"];
}

interface TimedRun {
  cued: Map<PlannedCue, CuedBlock>;
  clusterTicks: number;
}

interface FetchedRound {
  windows: WindowIndex;
  timed: Map<PlannedCue, CuedBlock>;
}

const FRAMES_PER_ROUND = 4096;

const unheld = (ranges: readonly Range[], headBytes: number, fileSize: number): Range[] =>
  ranges.flatMap((range) => {
    const length = available(range.at, range.length, fileSize);
    if (length === 0 || range.at + length <= headBytes) return [];
    return [{ at: range.at, length }];
  });

async function followIndex(
  source: Source,
  knobs: IndexFetch,
  header: IndexedHeader,
  plan: ReadPlan,
  watch: Watch,
): Promise<Map<number, Event[]> | RefusalCode> {
  const planned = planFrames(header, plan.wanted);
  if (!Array.isArray(planned)) return planned;
  const headBytes = header.head.bytes.length;
  const rounds: PlannedRound[] = [];
  for (let start = 0; start < planned.length; start += FRAMES_PER_ROUND) {
    const slice = planned.slice(start, start + FRAMES_PER_ROUND);
    const cues = slice.map((p) => p.cue);
    const edges = [...cues.slice(0, 1), ...cues.slice(-1)];
    const edgeClusters = new Set(edges.map((cue) => cue.clusterPos));
    const blocks = planRanges(cues, knobs.cueAheadBytes);
    const heads = planProbes(edgeClusters);
    const wanted = [...blocks, ...heads];
    const bought = unheld(wanted, headBytes, header.fileSize);
    const spans = coalesce(bought, knobs);
    const beyondHead = (sum: number, span: Range) =>
      sum + (span.at + span.length - Math.max(span.at, headBytes));
    const round = { slice, spans, bytes: spans.reduce(beyondHead, 0) };
    rounds.push(round);
  }
  const totalBytes = headBytes + rounds.reduce((sum, r) => sum + r.bytes, 0);
  watch.onProgress(headBytes, totalBytes);
  const clusterStarts = clusterStartsOf(header);
  const round = {
    sized: { source, fileSize: header.fileSize },
    clusterStarts,
    segmentEnd: header.segment.end,
    knobs,
    timeline: plan.timeline,
    head: header.head,
  };
  const progressBytes = { headBytes, totalBytes };
  const collected = await collectByRound(round, rounds, progressBytes, watch);
  if (!Array.isArray(collected)) return collected;
  return vouchedRuns(header, plan.wanted, collected);
}

function planFrames(
  header: IndexedHeader,
  wanted: readonly TrackEntry[],
): PlannedCue[] | RefusalCode {
  const planned: PlannedCue[] = [];
  for (const track of wanted) {
    const cues = header.cues.get(track.number);
    if (cues === undefined || cues.length === 0) {
      // A track that says it has no frame, or one a damaged file relabelled away.
      if (statedFrameCount(header, track) === 0) continue;
      return "unreadable";
    }
    if (repeatedPosition(cues)) {
      return "unreadable";
    }
    const numbered = isNumbered(track);
    for (const cue of cues) planned.push({ track, numbered, cue });
  }
  planned.sort((a, b) => a.cue.clusterPos - b.cue.clusterPos || a.cue.relPos - b.cue.relPos);
  return planned;
}

function vouchedRuns(
  header: IndexedHeader,
  wanted: readonly TrackEntry[],
  collected: readonly TrackedEvent[],
): Map<number, Event[]> | RefusalCode {
  const out = new Map<number, Event[]>();
  for (const track of wanted) {
    const events = collected.filter((e) => e.track === track.number).map((e) => e.event);
    if (brokenRun(events)) return "unreadable";
    const frames = statedFrameCount(header, track);
    if (frames !== null && frames !== events.length) {
      return "unreadable";
    }
    if (frames === null && !isNumbered(track)) {
      return "unreadable";
    }
    if (frames === null && anchorless(events)) {
      return "unreadable";
    }
    out.set(track.number, events);
  }
  return out;
}

function repeatedPosition(cues: readonly CuePosition[]): boolean {
  const seen = new Map<number, Set<number>>();
  for (const { clusterPos, relPos } of cues) {
    const inCluster = seen.get(clusterPos);
    if (inCluster === undefined) {
      const first = new Set([relPos]);
      seen.set(clusterPos, first);
      continue;
    }
    if (inCluster.has(relPos)) return true;
    inCluster.add(relPos);
  }
  return false;
}

function clusterStartsOf(header: IndexedHeader): number[] {
  const starts = new Set<number>();
  for (const cues of header.cues.values()) {
    for (const { clusterPos } of cues) starts.add(clusterPos);
  }
  return [...starts].sort((a, b) => a - b);
}

async function collectByRound(
  round: RoundInvariants,
  rounds: readonly PlannedRound[],
  { headBytes, totalBytes }: { headBytes: number; totalBytes: number },
  { onProgress, signal }: Watch,
): Promise<TrackedEvent[] | RefusalCode> {
  const events: TrackedEvent[] = [];
  let doneBytes = headBytes;
  for (const planned of rounds) {
    stopIfAborted(signal);
    const { windows, timed } = await fetchRound(round, planned, signal);
    const roundEvents = await readRound(round.timeline, windows, planned.slice, timed);
    if (!Array.isArray(roundEvents)) return roundEvents;
    events.push(...roundEvents);
    doneBytes += planned.bytes;
    onProgress(doneBytes, totalBytes);
  }
  stopIfAborted(signal);
  return events;
}

/**
 * The windows a round's frames are read from, and which of its cues are read by their own time.
 *
 * Every other cluster and every sampled one has its head bought,
 * and one sample that disagrees sends the whole round to its heads.
 */
async function fetchRound(
  round: RoundInvariants,
  { slice, spans }: PlannedRound,
  signal: AbortSignal | undefined,
): Promise<FetchedRound> {
  const { sized, knobs, head } = round;
  const bought = await fetchSpans(sized, spans, knobs.concurrency, signal);
  const buy = async (ranges: readonly Range[]) => {
    const beyondHead = unheld(ranges, head.bytes.length, sized.fileSize);
    const fetched = await fetchRanges(sized, beyondHead, knobs, signal);
    bought.push(...fetched);
    return new WindowIndex(bought, head);
  };
  const blockWindows = new WindowIndex(bought, head);
  const timed = timedByCue(blockWindows, slice, round);
  const sampled = samplesOf(timed);
  const asked = new Set(sampled);
  for (const planned of slice) {
    if (!timed.has(planned)) asked.add(planned.cue.clusterPos);
  }
  const askedHeads = unheldHeads(blockWindows, asked, sized.fileSize);
  const heads = planProbes(askedHeads);
  const timedBlocks = timed.values();
  const tails = planCuedShortfall(blockWindows, timedBlocks);
  const checked = await buy([...heads, ...tails]);
  if (!sampledAgree(checked, timed, sampled)) timed.clear();
  const untimed = slice.filter((planned) => !timed.has(planned)).map((planned) => planned.cue);
  const untimedClusters = untimed.map((cue) => cue.clusterPos);
  const missingHeads = unheldHeads(checked, untimedClusters, sized.fileSize);
  const missingProbes = planProbes(missingHeads);
  const located = await buy(missingProbes);
  const untimedTails = planShortfall(located, untimed);
  const windows = await buy(untimedTails);
  return { windows, timed };
}

function unheldHeads(windows: WindowIndex, clusters: Iterable<number>, fileSize: number): number[] {
  const unheldAt: number[] = [];
  for (const at of new Set(clusters)) {
    const need = available(at, CLUSTER_PROBE_BYTES, fileSize);
    if (windows.find(at, need) === null) unheldAt.push(at);
  }
  return unheldAt;
}

/** The cues whose blocks are read by their own time, a cluster's cues all or none. */
function timedByCue(
  windows: WindowIndex,
  slice: readonly PlannedCue[],
  { clusterStarts, segmentEnd }: RoundInvariants,
): Map<PlannedCue, CuedBlock> {
  const byCluster = new Map<number, PlannedCue[]>();
  for (const planned of slice) {
    const run = byCluster.get(planned.cue.clusterPos);
    if (run === undefined) byCluster.set(planned.cue.clusterPos, [planned]);
    else run.push(planned);
  }
  const kept: TimedRun[] = [];
  for (const [clusterPos, run] of byCluster) {
    const limit = limitAfter(clusterStarts, clusterPos, segmentEnd);
    const timedRun = cuedRun(windows, run, limit);
    if (timedRun === null) continue;
    const previous = kept.at(-1);
    if (previous !== undefined && timedRun.clusterTicks < previous.clusterTicks) {
      kept.pop();
      continue;
    }
    kept.push(timedRun);
  }
  const timed = new Map<PlannedCue, CuedBlock>();
  for (const { cued } of kept) {
    for (const [planned, block] of cued) timed.set(planned, block);
  }
  return timed;
}

function cuedRun(windows: WindowIndex, run: readonly PlannedCue[], limit: number): TimedRun | null {
  const cued = new Map<PlannedCue, CuedBlock>();
  for (const planned of run) {
    const block = locateByCue(windows, planned.cue, planned.track.number);
    if (block === null || block.outer.next > limit) return null;
    cued.set(planned, block);
  }
  const blocks = [...cued.values()];
  const clock = blocks[0] as CuedBlock;
  const oneCluster = blocks.every(
    (block) => block.clusterBody === clock.clusterBody && block.clusterTicks === clock.clusterTicks,
  );
  if (!oneCluster) return null;
  const { clusterTicks } = clock;
  return { cued, clusterTicks };
}

function limitAfter(starts: readonly number[], clusterPos: number, segmentEnd: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] as number) <= clusterPos) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return starts[low] ?? segmentEnd;
}

/**
 * The clusters whose heads check a round's cue times:
 * its first, its last, and its first with a cue off its clock.
 */
function samplesOf(timed: ReadonlyMap<PlannedCue, CuedBlock>): Set<number> {
  const clusters = new Set<number>();
  let offClock: number | null = null;
  for (const [{ cue }, { clusterTicks }] of timed) {
    clusters.add(cue.clusterPos);
    if (offClock === null && cue.ticks !== clusterTicks) {
      offClock = cue.clusterPos;
    }
  }
  const inOrder = [...clusters];
  const sampled = new Set([...inOrder.slice(0, 1), ...inOrder.slice(-1)]);
  if (offClock !== null) sampled.add(offClock);
  return sampled;
}

function sampledAgree(
  windows: WindowIndex,
  timed: ReadonlyMap<PlannedCue, CuedBlock>,
  sampled: ReadonlySet<number>,
): boolean {
  for (const [{ cue }, cued] of timed) {
    if (sampled.has(cue.clusterPos) && !agreesWithCluster(windows, cue, cued)) return false;
  }
  return true;
}

async function readRound(
  timeline: Timeline,
  windows: WindowIndex,
  planned: readonly PlannedCue[],
  timed: ReadonlyMap<PlannedCue, CuedBlock>,
): Promise<TrackedEvent[] | RefusalCode> {
  const events: TrackedEvent[] = [];
  const memo: ClusterMemo = { last: null };
  for (const entry of planned) {
    const { track, numbered, cue: point } = entry;
    const cued = timed.get(entry);
    const frame =
      cued === undefined
        ? await readFrame(windows, point, track.number, numbered, memo)
        : await readCuedFrame(windows, cued, track.number, numbered);
    if (typeof frame === "string") return "unreadable";
    const attributed = { track: track.number, event: eventOf(frame, timeline) };
    events.push(attributed);
  }
  return events;
}

function anchorless(events: readonly Event[]): boolean {
  return (
    events.length > 0 &&
    events.every((e) => e.readOrder !== null) &&
    !events.some((e) => e.readOrder === 0)
  );
}

function brokenRun(events: readonly Event[]): boolean {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let tally = 0;
  const distinct = new Set<number>();
  for (const { readOrder } of events) {
    if (readOrder === null) break;
    low = Math.min(low, readOrder);
    high = Math.max(high, readOrder);
    distinct.add(readOrder);
    tally += 1;
  }
  if (tally === events.length && tally > 0) {
    if (distinct.size !== tally) return true;
    if (high - low + 1 !== tally) return true;
  }
  return false;
}
