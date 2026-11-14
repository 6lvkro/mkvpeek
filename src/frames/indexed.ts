import { isGrammarError, type Window } from "../ebml.js";
import { stopIfAborted, type Watch } from "../io/abort.js";
import { gathered } from "../io/lanes.js";
import { available, type IndexFetch, type Range, type SizedSource } from "../io/source.js";
import { coalesceAcross, fetchSpans, StoneIndex, WindowIndex } from "../io/windows.js";
import { plainFrame, undoneFrame } from "../matroska/block.js";
import { CLUSTER_PROBE_BYTES } from "../matroska/chain.js";
import type { CueIndex, CuePosition } from "../matroska/cues.js";
import type { OpenedTrack } from "../matroska/header.js";
import {
  blockShortfall,
  type LocatedBlock,
  locateByClusterHeads,
  locateByCue,
  planBlockRanges,
  planProbes,
  readLocatedFrame,
} from "../matroska/indexed.js";
import { RefusalError } from "../vocabulary.js";
import { type ClaimsByNumber, claimFor, type TrackClaim, vouchable } from "./claim.js";
import type { Frame } from "./contract.js";
import type { FrameFile } from "./file.js";
import { frameOn, type Timeline } from "./timeline.js";

/** A group's frames, and the cue of the last, which every later frame lies past. */
export interface IndexedGroup {
  frames: Frame[];
  through: CuePosition;
}

/** Hands over a round's frames a group at a time, each group once it is read. */
export async function* framesByIndex(
  file: FrameFile,
  claims: ClaimsByNumber,
  knobs: IndexFetch,
  watch: Watch,
  strict: boolean,
): AsyncGenerator<IndexedGroup> {
  try {
    const parts = [() => file.timeline(watch.signal), () => file.cues(watch.signal)] as const;
    const [timeline, cues] = await gathered(parts, knobs.concurrency, watch.signal);
    const plan = planFrames(cues, claims, strict);
    const { head } = file;
    const headBytes = head.bytes.length;
    const stones = stonesOf(file, cues, claims);
    const rounds: PlannedRound[] = [];
    for (let start = 0; start < plan.length; start += FRAMES_PER_ROUND) {
      const slice = plan.slice(start, start + FRAMES_PER_ROUND);
      const positions = slice.map((p) => p.cue);
      const blocks = planBlockRanges(positions);
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
      claims,
    };
    const progressBytes = { headBytes, totalBytes };
    yield* byRound(invariants, rounds, progressBytes, watch);
  } catch (error) {
    // Grammar the index meets says this path could not read the file, not that the container is broken.
    if (isGrammarError(error)) throw new RefusalError("unreadable");
    throw error;
  }
}

interface PlannedRound {
  slice: PlannedCue[];
  spans: Range[];
  bytes: number;
}

interface PlannedCue {
  claim: TrackClaim;
  cue: CuePosition;
}

interface RoundInvariants {
  sized: SizedSource;
  clusterStarts: readonly number[];
  segmentEnd: number;
  knobs: IndexFetch;
  head: Window;
  strict: boolean;
  timeline: Timeline;
  claims: ClaimsByNumber;
}

interface TimedRun {
  from: number;
  blocks: LocatedBlock[];
  clusterTicks: number;
}

interface ProbedRound extends FetchedGroup {
  located: (LocatedBlock | null)[];
  /** Each cue's block bytes the probes left unbought. */
  tails: (Range | null)[];
}

interface FetchedGroup {
  windows: WindowIndex;
  unplannedBytes: number;
}

/** A run of a round's cues, read and handed over together. */
interface Group {
  from: number;
  to: number;
}

/** The blocks of a slice's cues read by their own time, each at its cue's place in the slice. */
type Timed = (LocatedBlock | undefined)[];

const FRAMES_PER_ROUND = 4096;

/** What a group may buy past its round's probes, as a round of large frames would otherwise hold them all. */
const GROUP_BYTES = 2 * 1024 ** 2;

const NO_STONES = new StoneIndex([]);

/** A range that crosses the head's edge is kept whole, since split there its element would lie in no window. */
const unheld = (ranges: readonly Range[], head: Window): Range[] =>
  ranges.flatMap((range) => {
    const length = available(range.at, range.length, head.fileSize);
    if (length === 0 || range.at + length <= head.bytes.length) return [];
    return [{ at: range.at, length }];
  });

const bytesOf = (spans: readonly Range[]): number =>
  spans.reduce((sum, span) => sum + span.length, 0);

function planFrames(byTrack: CueIndex, claims: ClaimsByNumber, strict: boolean): PlannedCue[] {
  const planned: PlannedCue[] = [];
  for (const claim of claims.values()) {
    const cues = byTrack.get(claim.track.number) ?? [];
    if (!vouchable(claim, cues.length, strict)) {
      throw new RefusalError("unreadable");
    }
    for (const cue of cues) planned.push({ claim, cue });
  }
  planned.sort((a, b) => a.cue.clusterPos - b.cue.clusterPos || a.cue.relPos - b.cue.relPos);
  return planned;
}

/** The blocks the other readable tracks' cues name, which may close the holes between this read's. */
function stonesOf(file: FrameFile, byTrack: CueIndex, claims: ClaimsByNumber): StoneIndex {
  const chosen = new Set(claims.keys());
  const givesStones = (openedTrack: OpenedTrack) =>
    !chosen.has(openedTrack.track.number) && claimFor(openedTrack) !== null;
  const readable = file.openedTracks.filter(givesStones);
  const numbers = new Set(readable.map(({ track }) => track.number));
  const cues = [...byTrack]
    .filter(([number]) => numbers.has(number))
    .flatMap(([, positions]) => positions);
  const blocks = planBlockRanges(cues);
  const stones = unheld(blocks, file.head);
  return new StoneIndex(stones);
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
  let blocksEnd = 0;
  for (const round of rounds) {
    stopIfAborted(signal);
    const probed = await probeRound(invariants, round, signal);
    blocksEnd = disjointEnd(probed.located, blocksEnd);
    doneBytes += probed.unplannedBytes;
    priceBytes += probed.unplannedBytes;
    for (const group of groupsOf(probed.tails, GROUP_BYTES)) {
      const lacking = probed.tails.slice(group.from, group.to).filter((tail) => tail !== null);
      const { windows, unplannedBytes } = await buy(invariants, lacking, probed.windows, signal);
      const slice = round.slice.slice(group.from, group.to);
      const located = probed.located.slice(group.from, group.to);
      const groupFrames = await readGroup(windows, slice, located, invariants);
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

/** Following a block that starts before the previous one ends buys and copies the same bytes again for each cue. */
function disjointEnd(located: readonly (LocatedBlock | null)[], from: number): number {
  let end = from;
  for (const block of located) {
    if (block === null) continue;
    if (block.blockAt < end) throw new RefusalError("unreadable");
    end = block.outer.next;
  }
  return end;
}

/** A cue not read by its own time has its cluster's head bought. */
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
    cued === undefined ? null : blockShortfall(blockWindows, cued),
  );
  const untimedAt: number[] = [];
  for (let at = 0; at < slice.length; at += 1) {
    if (timed[at] === undefined) untimedAt.push(at);
  }
  const untimed = untimedAt.map((at) => (slice[at] as PlannedCue).cue);
  const clusters = untimed.map((cue) => cue.clusterPos);
  const heads = unheldHeads(blockWindows, clusters);
  const probes = planProbes(heads);
  const leading = leadingTails(timed, tails, GROUP_BYTES);
  const riding = leading.map((at) => tails[at] as Range);
  const toProbe = [...probes, ...riding];
  const { windows, unplannedBytes } = await buy(invariants, toProbe, blockWindows, signal);
  for (const at of leading) {
    tails[at] = null;
  }
  const located = timed.map((cued) => cued ?? null);
  const untimedLocated = locateByClusterHeads(windows, untimed);
  for (let i = 0; i < untimedAt.length; i += 1) {
    const at = untimedAt[i] as number;
    const block = untimedLocated[i] ?? null;
    located[at] = block;
    tails[at] = block === null ? null : blockShortfall(windows, block);
  }
  return { windows, unplannedBytes, located, tails };
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

function timedRunOf(
  windows: WindowIndex,
  slice: readonly PlannedCue[],
  from: number,
  to: number,
  limit: number,
): TimedRun | null {
  const blocks: LocatedBlock[] = [];
  for (let i = from; i < to; i += 1) {
    const { cue, claim } = slice[i] as PlannedCue;
    const block = locateByCue(windows, cue, claim.track.number);
    if (block === null || block.outer.next > limit) return null;
    blocks.push(block);
  }
  const first = blocks[0] as LocatedBlock;
  const oneCluster = blocks.every(
    (block) => block.clusterBody === first.clusterBody && block.clusterTicks === first.clusterTicks,
  );
  if (!oneCluster) return null;
  const { clusterTicks } = first;
  return { from, blocks, clusterTicks };
}

function unheldHeads(windows: WindowIndex, clusters: Iterable<number>): number[] {
  const unheldAt: number[] = [];
  for (const at of new Set(clusters)) {
    if (windows.find(at, CLUSTER_PROBE_BYTES) === null) unheldAt.push(at);
  }
  return unheldAt;
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

async function buy(
  { sized, knobs, head }: RoundInvariants,
  ranges: readonly Range[],
  under: WindowIndex,
  signal: AbortSignal,
): Promise<FetchedGroup> {
  const toBuy = unheld(ranges, head);
  const extra = coalesceAcross(toBuy, NO_STONES, knobs);
  const fetched = await fetchSpans(sized, extra, knobs.concurrency, signal);
  return { windows: new WindowIndex(fetched, undefined, under), unplannedBytes: bytesOf(extra) };
}

async function readGroup(
  windows: WindowIndex,
  slice: readonly PlannedCue[],
  located: readonly (LocatedBlock | null)[],
  { claims, timeline }: RoundInvariants,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    const { number, index } = (slice[i] as PlannedCue).claim.track;
    const block = located[i] ?? null;
    const stored = block === null ? null : readLocatedFrame(windows, block, number, claims);
    if (stored === null) throw new RefusalError("unreadable");
    const frame =
      stored.undo === null ? plainFrame(stored) : await undoneFrame(stored, stored.undo);
    if (typeof frame === "string") throw new RefusalError("unreadable");
    frames.push(frameOn(frame, index, timeline));
  }
  return frames;
}
