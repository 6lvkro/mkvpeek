import type { Window } from "../ebml.js";
import { gathered } from "../io/lanes.js";
import {
  available,
  type IndexFetch,
  type Range,
  type SizedSource,
  stopIfAborted,
  type Watch,
} from "../io/source.js";
import { coalesceAcross, fetchRanges, fetchSpans, WindowIndex } from "../io/windows.js";
import type { ClaimedFrame } from "../matroska/block.js";
import { CLUSTER_PROBE_BYTES } from "../matroska/chain.js";
import {
  agreesWithCluster,
  type ClusterMemo,
  type CuedBlock,
  locateByCue,
  planBlockRanges,
  planCuedShortfall,
  planProbes,
  planShortfall,
  readCuedFrame,
  readFrame,
} from "../matroska/cues.js";
import type { CueIndex, CuePosition, TrackEntry } from "../matroska/header.js";
import type { RefusalCode } from "../vocabulary.js";
import { claimFor, type FrameFile, type TrackClaim, vouchable } from "./claim.js";
import type { Frame } from "./contract.js";
import { frameOn, timelineOf } from "./timeline.js";

/** Hands over no frame until every chosen track's frames are read. */
export async function framesByIndex(
  file: FrameFile,
  claims: readonly TrackClaim[],
  knobs: IndexFetch,
  watch: Watch,
  strict: boolean,
): Promise<Frame[] | RefusalCode> {
  const parts = [
    () => file.firstClusterTicks(watch.signal),
    () => file.cues(watch.signal),
  ] as const;
  const [firstClusterTicks, cues] = await gathered(parts, knobs.concurrency, watch.signal);
  const timeline = timelineOf(file, firstClusterTicks);
  if (typeof timeline === "string") return timeline;
  const plan = planFrames(cues, claims, strict);
  if (!Array.isArray(plan)) return plan;
  const { head } = file;
  const headBytes = head.bytes.length;
  const stones = stonesOf(file, cues, claims, knobs.cueAheadBytes);
  const rounds: PlannedRound[] = [];
  for (let start = 0; start < plan.length; start += FRAMES_PER_ROUND) {
    const slice = plan.slice(start, start + FRAMES_PER_ROUND);
    const positions = slice.map((p) => p.cue);
    const edges = [...positions.slice(0, 1), ...positions.slice(-1)];
    const edgeClusters = new Set(edges.map((cue) => cue.clusterPos));
    const blocks = planBlockRanges(positions, knobs.cueAheadBytes);
    const probes = planProbes(edgeClusters);
    const wanted = [...blocks, ...probes];
    const toBuy = unheld(wanted, head);
    const spans = coalesceAcross(toBuy, stones, knobs);
    const beyondHead = (sum: number, span: Range) =>
      sum + (span.at + span.length - Math.max(span.at, headBytes));
    const round = { slice, spans, bytes: spans.reduce(beyondHead, 0) };
    rounds.push(round);
  }
  const totalBytes = headBytes + rounds.reduce((sum, r) => sum + r.bytes, 0);
  watch.onProgress(headBytes, totalBytes);
  const clusterStarts = clusterStartsOf(cues);
  const invariants = {
    sized: { source: file.source, fileSize: head.fileSize },
    clusterStarts,
    segmentEnd: file.segment.end,
    knobs,
    head,
    strict,
  };
  const progressBytes = { headBytes, totalBytes };
  const claimed = await collectByRound(invariants, rounds, progressBytes, watch);
  if (!Array.isArray(claimed)) return claimed;
  return claimed.map((frame) => frameOn(frame, timeline));
}

interface PlannedCue {
  claim: TrackClaim;
  cue: CuePosition;
}

interface PlannedRound {
  slice: PlannedCue[];
  spans: Range[];
  bytes: number;
}

interface RoundInvariants {
  sized: SizedSource;
  clusterStarts: readonly number[];
  segmentEnd: number;
  knobs: IndexFetch;
  head: Window;
  strict: boolean;
}

interface TimedRun {
  byCue: Map<PlannedCue, CuedBlock>;
  clusterTicks: number;
}

interface FetchedRound {
  windows: WindowIndex;
  timed: Map<PlannedCue, CuedBlock>;
}

const FRAMES_PER_ROUND = 4096;

/** The ranges that lie past the head already read, each cut at the end of the file. */
const unheld = (ranges: readonly Range[], head: Window): Range[] =>
  ranges.flatMap((range) => {
    const length = available(range.at, range.length, head.fileSize);
    if (length === 0 || range.at + length <= head.bytes.length) return [];
    return [{ at: range.at, length }];
  });

function planFrames(
  byTrack: CueIndex,
  claims: readonly TrackClaim[],
  strict: boolean,
): PlannedCue[] | RefusalCode {
  const planned: PlannedCue[] = [];
  for (const claim of claims) {
    const cues = byTrack.get(claim.entry.number) ?? [];
    // Each cue reads one frame or refuses the read.
    if (!vouchable(claim, cues.length, strict)) {
      return "unreadable";
    }
    if (repeatedPosition(cues)) {
      return "unreadable";
    }
    for (const cue of cues) planned.push({ claim, cue });
  }
  planned.sort((a, b) => a.cue.clusterPos - b.cue.clusterPos || a.cue.relPos - b.cue.relPos);
  return planned;
}

/** The blocks the other readable tracks' cues name, which may close the holes between this read's. */
function stonesOf(
  file: FrameFile,
  byTrack: CueIndex,
  claims: readonly TrackClaim[],
  cueAheadBytes: number,
): Range[] {
  const chosen = new Set(claims.map(({ entry }) => entry.number));
  const givesStones = (entry: TrackEntry) =>
    !chosen.has(entry.number) && claimFor(entry, file) !== null;
  const readable = file.trackEntries.filter(givesStones);
  const numbers = new Set(readable.map((entry) => entry.number));
  const cues = [...byTrack]
    .filter(([number]) => numbers.has(number))
    .flatMap(([, positions]) => positions);
  const blocks = planBlockRanges(cues, cueAheadBytes);
  return unheld(blocks, file.head);
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

function clusterStartsOf(byTrack: CueIndex): number[] {
  const starts = new Set<number>();
  for (const cues of byTrack.values()) {
    for (const { clusterPos } of cues) starts.add(clusterPos);
  }
  return [...starts].sort((a, b) => a - b);
}

async function collectByRound(
  invariants: RoundInvariants,
  rounds: readonly PlannedRound[],
  { headBytes, totalBytes }: { headBytes: number; totalBytes: number },
  { onProgress, signal }: Watch,
): Promise<ClaimedFrame<TrackClaim>[] | RefusalCode> {
  const claimed: ClaimedFrame<TrackClaim>[] = [];
  let doneBytes = headBytes;
  for (const round of rounds) {
    stopIfAborted(signal);
    const { windows, timed } = await fetchRound(invariants, round, signal);
    const roundFrames = await readRound(windows, round.slice, timed);
    if (!Array.isArray(roundFrames)) return roundFrames;
    claimed.push(...roundFrames);
    doneBytes += round.bytes;
    onProgress(doneBytes, totalBytes);
  }
  stopIfAborted(signal);
  return claimed;
}

/**
 * The windows a round's frames are read from, and which of its cues are read by their own time.
 *
 * Every other cluster and every sampled one has its head bought,
 * and one sample that disagrees sends the whole round to its heads.
 */
async function fetchRound(
  invariants: RoundInvariants,
  { slice, spans }: PlannedRound,
  signal: AbortSignal,
): Promise<FetchedRound> {
  const { sized, knobs, head, strict } = invariants;
  const bought = await fetchSpans(sized, spans, knobs.concurrency, signal);
  const buy = async (ranges: readonly Range[]) => {
    const toBuy = unheld(ranges, head);
    const fetched = await fetchRanges(sized, toBuy, knobs, signal);
    bought.push(...fetched);
    return new WindowIndex(bought, head);
  };
  const blockWindows = new WindowIndex(bought, head);
  const timed = timedByCue(blockWindows, slice, invariants);
  const sampled = samplesOf(timed, strict);
  const probedClusters = new Set(sampled);
  for (const planned of slice) {
    if (!timed.has(planned)) probedClusters.add(planned.cue.clusterPos);
  }
  const probedHeads = unheldHeads(blockWindows, probedClusters, sized.fileSize);
  const probes = planProbes(probedHeads);
  const timedBlocks = timed.values();
  const tails = planCuedShortfall(blockWindows, timedBlocks);
  const checked = await buy([...probes, ...tails]);
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
    const timedRun = timedRunOf(windows, run, limit);
    if (timedRun === null) continue;
    const previous = kept.at(-1);
    if (previous !== undefined && timedRun.clusterTicks < previous.clusterTicks) {
      kept.pop();
      continue;
    }
    kept.push(timedRun);
  }
  const timed = new Map<PlannedCue, CuedBlock>();
  for (const { byCue } of kept) {
    for (const [planned, block] of byCue) timed.set(planned, block);
  }
  return timed;
}

function timedRunOf(
  windows: WindowIndex,
  run: readonly PlannedCue[],
  limit: number,
): TimedRun | null {
  const byCue = new Map<PlannedCue, CuedBlock>();
  for (const planned of run) {
    const block = locateByCue(windows, planned.cue, planned.claim.entry.number);
    if (block === null || block.outer.next > limit) return null;
    byCue.set(planned, block);
  }
  const blocks = [...byCue.values()];
  const first = blocks[0] as CuedBlock;
  const oneCluster = blocks.every(
    (block) => block.clusterBody === first.clusterBody && block.clusterTicks === first.clusterTicks,
  );
  if (!oneCluster) return null;
  const { clusterTicks } = first;
  return { byCue, clusterTicks };
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
 * its first, its last, and its first with a cue off its clock, or every one of them if the read is strict.
 */
function samplesOf(timed: ReadonlyMap<PlannedCue, CuedBlock>, strict: boolean): Set<number> {
  const clusters = new Set<number>();
  let offTicks: number | null = null;
  for (const [{ cue }, { clusterTicks }] of timed) {
    clusters.add(cue.clusterPos);
    if (offTicks === null && cue.ticks !== clusterTicks) {
      offTicks = cue.clusterPos;
    }
  }
  if (strict) return clusters;
  const inOrder = [...clusters];
  const sampled = new Set([...inOrder.slice(0, 1), ...inOrder.slice(-1)]);
  if (offTicks !== null) sampled.add(offTicks);
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
  windows: WindowIndex,
  slice: readonly PlannedCue[],
  timed: ReadonlyMap<PlannedCue, CuedBlock>,
): Promise<ClaimedFrame<TrackClaim>[] | RefusalCode> {
  const claimed: ClaimedFrame<TrackClaim>[] = [];
  const memo: ClusterMemo = { last: null };
  for (const planned of slice) {
    const { claim, cue } = planned;
    const { number } = claim.entry;
    const cued = timed.get(planned);
    const frame =
      cued === undefined
        ? await readFrame(windows, cue, number, claim, memo)
        : await readCuedFrame(windows, cued, number, claim);
    if (typeof frame === "string") return "unreadable";
    claimed.push(frame);
  }
  return claimed;
}
