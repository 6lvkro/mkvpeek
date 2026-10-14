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
import { coalesceAcross, fetchSpans, WindowIndex } from "../io/windows.js";
import { plainFrame, undoneFrame } from "../matroska/block.js";
import { CLUSTER_PROBE_BYTES } from "../matroska/chain.js";
import {
  type ClusterMemo,
  type CuedBlock,
  cuedShortfall,
  locateByCue,
  planBlockRanges,
  planProbes,
  pointShortfalls,
  readCuedFrame,
  readFrame,
} from "../matroska/cues.js";
import type { CueIndex, CuePosition, TrackEntry } from "../matroska/header.js";
import { RefusalError } from "../vocabulary.js";
import { claimFor, type FrameFile, type TrackClaim, vouchable } from "./claim.js";
import type { Frame } from "./contract.js";
import { frameOn, type Timeline, timelineOf } from "./timeline.js";

/** A group's frames, and the cue of the last, which every later frame lies past. */
export interface IndexedGroup {
  frames: Frame[];
  through: CuePosition;
}

/** Hands over a round's frames a group at a time, each group once it is read. */
export async function* framesByIndex(
  file: FrameFile,
  claims: readonly TrackClaim[],
  knobs: IndexFetch,
  watch: Watch,
  strict: boolean,
): AsyncGenerator<IndexedGroup> {
  const parts = [
    () => file.firstClusterTicks(watch.signal),
    () => file.cues(watch.signal),
  ] as const;
  const [firstClusterTicks, cues] = await gathered(parts, knobs.concurrency, watch.signal);
  const timeline = timelineOf(file, firstClusterTicks);
  const plan = planFrames(cues, claims, strict);
  const { head } = file;
  const headBytes = head.bytes.length;
  const stones = stonesOf(file, cues, claims, knobs.cueAheadBytes);
  const rounds: PlannedRound[] = [];
  for (let start = 0; start < plan.length; start += FRAMES_PER_ROUND) {
    const slice = plan.slice(start, start + FRAMES_PER_ROUND);
    const positions = slice.map((p) => p.cue);
    const blocks = planBlockRanges(positions, knobs.cueAheadBytes);
    const toBuy = unheld(blocks, head);
    const spans = coalesceAcross(toBuy, stones, knobs);
    const round = { slice, spans, bytes: bytesOf(spans) };
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
    timeline,
  };
  const progressBytes = { headBytes, totalBytes };
  yield* byRound(invariants, rounds, progressBytes, watch);
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
  timeline: Timeline;
}

interface TimedRun {
  from: number;
  blocks: CuedBlock[];
  clusterTicks: number;
}

interface ProbedRound {
  windows: WindowIndex;
  timed: Timed;
  /** Each cue's block bytes the probes left unbought. */
  tails: (Range | null)[];
  unplannedBytes: number;
}

/** A run of a round's cues, read and handed over together. */
interface Group {
  from: number;
  to: number;
}

interface FetchedGroup {
  windows: WindowIndex;
  unplannedBytes: number;
}

/** The blocks of a slice's cues read by their own time, each at its cue's place in the slice. */
type Timed = (CuedBlock | undefined)[];

const FRAMES_PER_ROUND = 4096;

/** What a group may buy past its round's probes, as a round of large frames would otherwise hold them all. */
const GROUP_BYTES = 2 * 1024 ** 2;

/** A range that crosses the head's edge is kept whole, since split there its element would lie in no window. */
const unheld = (ranges: readonly Range[], head: Window): Range[] =>
  ranges.flatMap((range) => {
    const length = available(range.at, range.length, head.fileSize);
    if (length === 0 || range.at + length <= head.bytes.length) return [];
    return [{ at: range.at, length }];
  });

const bytesOf = (spans: readonly Range[]): number =>
  spans.reduce((sum, span) => sum + span.length, 0);

function planFrames(
  byTrack: CueIndex,
  claims: readonly TrackClaim[],
  strict: boolean,
): PlannedCue[] {
  const planned: PlannedCue[] = [];
  for (const claim of claims) {
    const cues = byTrack.get(claim.entry.number) ?? [];
    if (!vouchable(claim, cues.length, strict)) {
      throw new RefusalError("unreadable");
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

function clusterStartsOf(byTrack: CueIndex): number[] {
  const starts = new Set<number>();
  for (const cues of byTrack.values()) {
    for (const { clusterPos } of cues) starts.add(clusterPos);
  }
  return [...starts].sort((a, b) => a - b);
}

async function* byRound(
  invariants: RoundInvariants,
  rounds: readonly PlannedRound[],
  { headBytes, totalBytes }: { headBytes: number; totalBytes: number },
  { onProgress, signal }: Watch,
): AsyncGenerator<IndexedGroup> {
  let doneBytes = headBytes;
  let priceBytes = totalBytes;
  for (const round of rounds) {
    stopIfAborted(signal);
    const probed = await probeRound(invariants, round, signal);
    doneBytes += probed.unplannedBytes;
    priceBytes += probed.unplannedBytes;
    for (const group of groupsOf(probed.tails, GROUP_BYTES)) {
      const { windows, unplannedBytes } = await fetchGroup(invariants, probed, group, signal);
      const slice = round.slice.slice(group.from, group.to);
      const timed = probed.timed.slice(group.from, group.to);
      const groupFrames = await readGroup(windows, slice, timed, invariants.timeline);
      doneBytes += unplannedBytes;
      priceBytes += unplannedBytes;
      // The round's planned spans count as done with its last group, so the price is not met while a group remains.
      if (group.to === probed.tails.length) {
        doneBytes += round.bytes;
      }
      onProgress(doneBytes, priceBytes);
      const last = slice.at(-1) as PlannedCue;
      yield { frames: groupFrames, through: last.cue };
    }
  }
}

/**
 * The windows a round's probes buy, which of its cues are read by their own time, and what each cue's block still lacks.
 *
 * Every other cue has its cluster's head bought.
 */
async function probeRound(
  invariants: RoundInvariants,
  { slice, spans }: PlannedRound,
  signal: AbortSignal,
): Promise<ProbedRound> {
  const { sized, knobs, head, strict } = invariants;
  const bought = await fetchSpans(sized, spans, knobs.concurrency, signal);
  const blockWindows = new WindowIndex(bought, head);
  const timed = strict ? slice.map(() => undefined) : timedByCue(blockWindows, slice, invariants);
  // A timed cue's tail is known from the planned spans alone.
  const tails = timed.map((cued) =>
    cued === undefined ? null : cuedShortfall(blockWindows, cued),
  );
  const untimedAt: number[] = [];
  for (let at = 0; at < slice.length; at += 1) {
    if (timed[at] === undefined) untimedAt.push(at);
  }
  const untimed = untimedAt.map((at) => (slice[at] as PlannedCue).cue);
  const clusters = untimed.map((cue) => cue.clusterPos);
  const heads = unheldHeads(blockWindows, clusters, sized.fileSize);
  const probes = planProbes(heads);
  const leading = leadingTails(timed, tails, GROUP_BYTES);
  const riding = leading.map((at) => tails[at] as Range);
  const toProbe = unheld([...probes, ...riding], head);
  const extra = coalesceAcross(toProbe, [], knobs);
  const headWindows = await fetchSpans(sized, extra, knobs.concurrency, signal);
  bought.push(...headWindows);
  for (const at of leading) {
    tails[at] = null;
  }
  const windows = new WindowIndex(bought, head);
  const untimedTails = pointShortfalls(windows, untimed);
  for (let i = 0; i < untimedAt.length; i += 1) {
    tails[untimedAt[i] as number] = untimedTails[i] ?? null;
  }
  return { windows, timed, tails, unplannedBytes: bytesOf(extra) };
}

/** Runs of cues whose blocks lack at most the budget between them, or one cue that alone lacks more. */
function* groupsOf(tails: readonly (Range | null)[], budget: number): Generator<Group> {
  let from = 0;
  let bytes = 0;
  for (let at = 0; at < tails.length; at += 1) {
    const length = tails[at]?.length ?? 0;
    if (at > from && bytes + length > budget) {
      yield { from, to: at };
      from = at;
      bytes = 0;
    }
    bytes += length;
  }
  yield { from, to: tails.length };
}

/** Where the leading timed cues' tails fit the budget, as those need no probe and so ride with the probes. */
function leadingTails(timed: Timed, tails: readonly (Range | null)[], budget: number): number[] {
  const leading: number[] = [];
  let bytes = 0;
  for (let at = 0; at < timed.length && timed[at] !== undefined; at += 1) {
    const tail = tails[at];
    if (tail === null || tail === undefined) continue;
    if (leading.length > 0 && bytes + tail.length > budget) break;
    leading.push(at);
    bytes += tail.length;
  }
  return leading;
}

async function fetchGroup(
  { sized, knobs, head }: RoundInvariants,
  { windows, tails }: ProbedRound,
  { from, to }: Group,
  signal: AbortSignal,
): Promise<FetchedGroup> {
  const lacking = tails.slice(from, to).filter((tail) => tail !== null);
  const toBuy = unheld(lacking, head);
  const extra = coalesceAcross(toBuy, [], knobs);
  const fetched = await fetchSpans(sized, extra, knobs.concurrency, signal);
  return { windows: new WindowIndex(fetched, undefined, windows), unplannedBytes: bytesOf(extra) };
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
): Timed {
  const kept: TimedRun[] = [];
  let to = 0;
  // The plan is sorted by position, so a cluster's cues stand together.
  while (to < slice.length) {
    const from = to;
    const { clusterPos } = (slice[from] as PlannedCue).cue;
    while (slice[to]?.cue.clusterPos === clusterPos) {
      to += 1;
    }
    const limit = limitAfter(clusterStarts, clusterPos, segmentEnd);
    const timedRun = timedRunOf(windows, slice, from, to, limit);
    if (timedRun === null) continue;
    const previous = kept.at(-1);
    if (previous !== undefined && timedRun.clusterTicks < previous.clusterTicks) {
      kept.pop();
      continue;
    }
    kept.push(timedRun);
  }
  const timed: Timed = new Array(slice.length).fill(undefined);
  for (const { from, blocks } of kept) {
    for (let i = 0; i < blocks.length; i += 1) {
      timed[from + i] = blocks[i];
    }
  }
  return timed;
}

function timedRunOf(
  windows: WindowIndex,
  slice: readonly PlannedCue[],
  from: number,
  to: number,
  limit: number,
): TimedRun | null {
  const blocks: CuedBlock[] = [];
  for (let i = from; i < to; i += 1) {
    const { cue, claim } = slice[i] as PlannedCue;
    const block = locateByCue(windows, cue, claim.entry.number);
    if (block === null || block.outer.next > limit) return null;
    blocks.push(block);
  }
  const first = blocks[0] as CuedBlock;
  const oneCluster = blocks.every(
    (block) => block.clusterBody === first.clusterBody && block.clusterTicks === first.clusterTicks,
  );
  if (!oneCluster) return null;
  const { clusterTicks } = first;
  return { from, blocks, clusterTicks };
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

async function readGroup(
  windows: WindowIndex,
  slice: readonly PlannedCue[],
  timed: Timed,
  timeline: Timeline,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  const memo: ClusterMemo = { last: null };
  for (let i = 0; i < slice.length; i += 1) {
    const { claim, cue } = slice[i] as PlannedCue;
    const { number, index } = claim.entry;
    const cued = timed[i];
    const stored =
      cued === undefined
        ? readFrame(windows, cue, number, claim, memo)
        : readCuedFrame(windows, cued, number, claim);
    if (typeof stored === "string") throw new RefusalError("unreadable");
    const frame =
      stored.undo === null ? plainFrame(stored) : await undoneFrame(stored, stored.undo);
    if (typeof frame === "string") throw new RefusalError("unreadable");
    frames.push(frameOn(frame, index, timeline));
  }
  return frames;
}
