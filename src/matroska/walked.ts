import type { Element, OpenElement, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { linkedSignal, stopIfAborted, type Watch } from "../io/abort.js";
import { HaltableQueue, joinOrAbort } from "../io/lanes.js";
import type { Range, SizedSource, WalkFetch } from "../io/source.js";
import { heldOrRead, holds, type Loaned, type WindowPool, windowPool } from "../io/windows.js";
import { RefusalError } from "../vocabulary.js";
import {
  BLOCK_PROBE_BYTES,
  type BlockFrame,
  type BlockRefusal,
  FRAME_IDS,
  type FrameClaim,
  GroupScan,
  plainFrame,
  readBlockFrame,
  skipsUnclaimed,
  undoneFrame,
  type WindowFinder,
} from "./block.js";
import { CLUSTER_PROBE_BYTES, hopTopLevel, readClusterTicks, type SegmentPass } from "./chain.js";
import type { CuePosition } from "./cues.js";
import { ID } from "./ids.js";

/** The cluster a walk takes over at from another read, and the body offset its blocks must lie past. */
export type WalkFrom = Pick<CuePosition, "clusterPos" | "relPos">;

/**
 * Hands over the chosen tracks' frames cluster by cluster, in file order.
 *
 * A refusal is a `RefusalError` after the clusters before it are handed over, and ending the iteration ends the read.
 */
export async function* walkFrames(
  opened: Omit<SegmentPass, "signal">,
  claims: ReadonlyMap<number, FrameClaim>,
  knobs: WalkFetch,
  watch: Watch,
  from?: WalkFrom,
): AsyncGenerator<BlockFrame[]> {
  const fileSize = opened.head.fileSize;
  // The bytes before the cluster a walk takes over at are done, as the read before it handed their frames over.
  const startBytes = from?.clusterPos ?? 0;
  watch.onProgress(startBytes, fileSize);
  const ended = linkedSignal(watch.signal);
  const { signal } = ended;
  const reading = { ...opened, signal };
  const slotBytes = Math.min(knobs.blockAheadBytes, fileSize);
  const pool = windowPool(slotBytes, knobs.concurrency + 4);
  const sized = { source: opened.source, fileSize };
  const walk: WalkInvariants = { sized, claims, knobs, head: opened.head, signal, from };
  // The hop takes one of the reads; with none to spare for a lane, it walks what it finds.
  const laneCount = knobs.concurrency - 1;
  const ahead = Math.max(1, laneCount) * CLUSTERS_AHEAD_PER_LANE;
  const outcomes = new Map<number, Ordered>();
  let doneBytes = startBytes;
  let foundCount = 0;
  let handedCount = 0;
  let parked: Array<() => void> = [];
  const wake = () => {
    for (const resolve of parked) resolve();
    parked = [];
  };
  const park = () =>
    new Promise<void>((resolve) => {
      parked.push(resolve);
    });
  const queue = new HaltableQueue<HoppedCluster>(wake);
  const admitted = async (index: number) => {
    while (!queue.halted && index - handedCount >= ahead) {
      await park();
      stopIfAborted(signal);
    }
    return !queue.halted;
  };
  const fail = (index: number, failed: unknown) => {
    stopIfAborted(signal);
    wake();
    outcomes.set(index, { failed });
  };
  const record = (
    index: number,
    span: ClusterSpan,
    outcome: SweptFrames | BlockRefusal,
  ): outcome is SweptFrames => {
    stopIfAborted(signal);
    wake();
    if (typeof outcome === "string") {
      outcomes.set(index, outcome);
      return false;
    }
    outcomes.set(index, outcome.frames);
    doneBytes += outcome.end - span.at;
    watch.onProgress(doneBytes, fileSize);
    return true;
  };

  const walkAndRecord = async (item: HoppedCluster) => {
    const outcome = await walkCluster(walk, item.span, pool, item.window).catch(
      (error: unknown) => {
        fail(item.index, error);
        return null;
      },
    );
    if (outcome === null) return false;
    const kept = record(item.index, item.span, outcome);
    if (kept) outcome.carried.release?.();
    return kept;
  };
  const feed = async (): Promise<void> => {
    // the window the previous open walk was carrying
    let seed: Loaned | undefined;
    try {
      let pos = from?.clusterPos ?? opened.segment.body;
      while (await admitted(foundCount)) {
        let openCluster: HoppedCluster | null = null;
        for await (const { at, el, window } of hopTopLevel(reading, pos)) {
          if (el.id === ID.segment.CLUSTER) {
            if ("open" in el) {
              openCluster = {
                index: foundCount++,
                span: { at, el, end: opened.segment.end },
                window,
              };
              break;
            }
            const sizedCluster = { index: foundCount++, span: { at, el, end: el.next }, window };
            if (laneCount > 0) {
              queue.push(sizedCluster);
            } else if (!(await walkAndRecord(sizedCluster))) {
              return;
            }
          }
          if (!(await admitted(foundCount))) return;
        }
        if (openCluster === null) break;
        const { index, span, window } = openCluster;
        const outcome = await walkCluster(walk, span, pool, seed ?? window).catch(
          (error: unknown) => {
            fail(index, error);
            return null;
          },
        );
        if (outcome === null || !record(index, span, outcome)) return;
        if (seed !== undefined && outcome.carried !== seed) seed.release?.();
        seed = outcome.carried;
        pos = outcome.end;
      }
    } catch (error) {
      fail(foundCount, error);
    } finally {
      queue.close();
      seed?.release?.();
      wake();
    }
  };

  const feeding = feed();
  const draining = queue.drain(laneCount, walkAndRecord, signal);
  let finished = false;
  const failures: unknown[] = [];
  const settled = joinOrAbort([feeding, draining], signal).then(
    () => {
      finished = true;
      wake();
    },
    (error: unknown) => {
      failures.push(error);
      finished = true;
      wake();
    },
  );
  try {
    for (;;) {
      const outcome = outcomes.get(handedCount);
      if (outcome !== undefined) {
        if (typeof outcome === "string") throw new RefusalError(outcome);
        if (!Array.isArray(outcome)) throw outcome.failed;
        outcomes.delete(handedCount);
        handedCount += 1;
        wake();
        if (outcome.length > 0) yield outcome;
        continue;
      }
      if (finished) break;
      await park();
    }
    if (failures.length > 0) throw failures[0];
    watch.onProgress(fileSize, fileSize);
  } finally {
    ended.abort();
    await settled;
  }
}

interface WalkInvariants {
  sized: SizedSource;
  claims: ReadonlyMap<number, FrameClaim>;
  knobs: WalkFetch;
  head: Window;
  signal: AbortSignal;
  from: WalkFrom | undefined;
}

type WalkedCluster = (SweptFrames & { carried: Loaned }) | BlockRefusal;

type Ordered = BlockFrame[] | BlockRefusal | { failed: unknown };

interface SweptFrames {
  frames: BlockFrame[];
  end: number;
}

/** Its window is the one the hop read the head from, and the walk's first probe. */
interface HoppedCluster {
  index: number;
  span: ClusterSpan;
  window: Window;
}

/** For a cluster without a size, `end` is the end of the Segment. */
interface ClusterSpan {
  at: number;
  el: Element | OpenElement;
  end: number;
}

interface Loans {
  pool: WindowPool;
  ledger: Set<Loaned>;
}

/** Hands back the windows bought for one block by range. Those a resumed read can no longer ask for are dropped. */
class BoughtWindows implements WindowFinder {
  readonly missed: Range = { at: 0, length: 0 };
  #bought: Window[] = [];

  find(at: number, length: number): Window | null {
    for (let i = this.#bought.length - 1; i >= 0; i -= 1) {
      const window = this.#bought[i] as Window;
      if (E.covers(window, at, length)) return window;
    }
    this.missed.at = at;
    this.missed.length = length;
    return null;
  }

  keep(window: Window, scan: GroupScan): void {
    this.#bought = this.#bought.filter((held) => scan.mayAsk(held));
    this.#bought.push(window);
  }

  clear(): void {
    this.#bought = [];
  }
}

const CLUSTER_CHILD_IDS = new Set<number>([
  ...Object.values(ID.cluster),
  ...Object.values(ID.global),
]);

const SEGMENT_CHILD_IDS = new Set<number>(Object.values(ID.segment));

/** How many clusters per lane the walk may find ahead of the one it hands over next. */
const CLUSTERS_AHEAD_PER_LANE = 4;

async function walkCluster(
  walk: WalkInvariants,
  span: ClusterSpan,
  pool: WindowPool,
  seed?: Loaned,
): Promise<WalkedCluster> {
  const ledger = new Set<Loaned>();
  let outcome: WalkedCluster | undefined;
  try {
    outcome = await walkSpan(walk, span, { pool, ledger }, seed);
    return outcome;
  } finally {
    if (outcome !== undefined && typeof outcome !== "string") ledger.delete(outcome.carried);
    for (const window of ledger) window.release?.();
  }
}

async function walkSpan(
  { sized, claims, knobs, head, signal, from }: WalkInvariants,
  span: ClusterSpan,
  { pool, ledger }: Loans,
  seed?: Loaned,
): Promise<WalkedCluster> {
  const widthFor = (at: number, need: number) => {
    const bound = Math.min(knobs.blockAheadBytes, span.end - at);
    return Math.max(need, bound);
  };
  const firstWidth = widthFor(span.at, CLUSTER_PROBE_BYTES);
  const fetchWindow = async (at: number, width: number) => {
    const window = await heldOrRead(sized.source, head, at, width, signal, pool);
    if (window.release !== undefined) ledger.add(window);
    return window;
  };
  const adopted = seed !== undefined && holds(seed, span.at, firstWidth) ? seed : null;
  // A Window so that nothing here releases it, as the ledger releases what was lent.
  let carried: Window = adopted ?? (await fetchWindow(span.at, firstWidth));
  const clusterTicks = readClusterTicks(carried, span.el);
  if (clusterTicks === null) return "malformed";

  const frames: BlockFrame[] = [];
  const handedThrough = from !== undefined && span.at === from.clusterPos ? from.relPos : -1;
  let pos = span.el.body;
  const supply = async (at: number, need: number) => {
    const width = widthFor(at, need);
    const window = await fetchWindow(at, width);
    if (E.reachOf(window) > E.reachOf(carried)) {
      carried = window;
    }
    return window;
  };
  const bought = new BoughtWindows();
  const scan = new GroupScan();
  const cursor = E.elementCursor();
  while (pos < span.end) {
    const need = Math.min(BLOCK_PROBE_BYTES, span.end - pos);
    const window = E.covers(carried, pos, need) ? carried : await supply(pos, need);
    if (!E.readElementInto(window, pos, cursor)) return "malformed";
    const { id, next } = cursor;
    if (!CLUSTER_CHILD_IDS.has(id)) {
      if ("open" in span.el && SEGMENT_CHILD_IDS.has(id)) return { frames, end: pos, carried };
      // An element no cluster holds. A broken spec and an element this reader does not know are not told apart.
      return "unreadable";
    }
    if (cursor.open || next > span.end) return "malformed";
    const handed = FRAME_IDS.has(id) && pos - span.el.body > handedThrough;
    if (handed && !skipsUnclaimed(window, cursor, claims)) {
      const el = { id, size: cursor.size, body: cursor.body, next };
      bought.clear();
      scan.restart();
      let stored = readBlockFrame(el, clusterTicks, window, claims, bought, scan);
      while (stored === "short") {
        const { at, length } = bought.missed;
        const supplied = await supply(at, length);
        bought.keep(supplied, scan);
        stored = readBlockFrame(el, clusterTicks, window, claims, bought, scan);
      }
      if (typeof stored === "string") return stored;
      if (stored !== null) {
        const frame =
          stored.undo === null ? plainFrame(stored) : await undoneFrame(stored, stored.undo);
        if (typeof frame === "string") return frame;
        frames.push(frame);
      }
    }
    pos = next;
  }
  return { frames, end: span.end, carried };
}
