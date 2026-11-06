import type { Window } from "../ebml.js";
import * as E from "../ebml.js";
import { stopIfAborted } from "./abort.js";
import { inParallel } from "./lanes.js";
import {
  available,
  type IndexFetch,
  LARGE_READ_BYTES,
  type Range,
  type SizedSource,
  type Source,
} from "./source.js";

export interface WindowPool {
  /** A lease when the width fits the threshold and a slot. */
  borrow(width: number): Lease | null;
}

/** For a window read into a lent slot, `release` gives the slot back to the pool, and the borrower calls it once. */
export type Loaned = Window & { readonly release?: () => void };

interface Lease {
  readonly bytes: Uint8Array;
  release: () => void;
}

export class WindowIndex {
  readonly #sorted: readonly Window[];
  readonly #widestSorted: number;
  readonly #head: Window | undefined;
  readonly #under: WindowIndex | undefined;

  /** An index over windows taken in `at` order, which answers from the index stacked under it too. */
  constructor(windows: readonly Window[], head?: Window, under?: WindowIndex) {
    this.#sorted = windows;
    this.#widestSorted = this.#sorted.reduce((max, w) => Math.max(max, w.bytes.length), 0);
    this.#head = head;
    this.#under = under;
  }

  /**
   * A window that holds the whole range;
   * which one answers where several do is not settled, so a caller asks for every byte it reads.
   */
  find(at: number, length: number): Window | null {
    if (this.#head !== undefined && holds(this.#head, at, length)) return this.#head;
    let low = 0;
    let high = this.#sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.#sorted[mid] as Window).at <= at) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    for (let i = low - 1; i >= 0; i--) {
      const window = this.#sorted[i] as Window;
      if (at - window.at > this.#widestSorted) break;
      if (holds(window, at, length)) return window;
    }
    return this.#under?.find(at, length) ?? null;
  }
}

export class StoneIndex {
  readonly #sorted: readonly Range[];

  constructor(stones: readonly Range[]) {
    this.#sorted = [...stones].sort(byAt);
  }

  within(from: number, to: number): readonly Range[] {
    const low = firstAtOrAfter(this.#sorted, from);
    const high = firstAtOrAfter(this.#sorted, to + 1);
    return this.#sorted.slice(low, high);
  }
}

export async function heldOrRead(
  source: Source,
  held: Window,
  at: number,
  length: number,
  signal: AbortSignal | undefined,
  pool?: WindowPool,
): Promise<Loaned> {
  if (holds(held, at, length)) return held;
  const sized = { source, fileSize: held.fileSize };
  const lease = pool?.borrow(length) ?? null;
  if (lease === null) return windowAt(sized, at, length, signal);
  let window: Window;
  try {
    window = await windowAt(sized, at, length, signal, lease.bytes);
  } catch (error) {
    lease.release();
    throw error;
  }
  if (window.bytes.buffer !== lease.bytes.buffer) {
    lease.release();
    return window;
  }
  return { ...window, release: lease.release };
}

export function holds(window: Window, at: number, length: number): boolean {
  const held = available(at, length, window.fileSize);
  return E.covers(window, at, held);
}

export async function fetchSpans(
  sized: SizedSource,
  spans: readonly Range[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<Window[]> {
  const windowFor = (span: Range) => windowAt(sized, span.at, span.length, signal);
  return inParallel(spans, concurrency, windowFor, signal);
}

/** The spans that read every wanted range, letting a stone close the hole between two of them. */
export function coalesceAcross(
  wanted: readonly Range[],
  stones: StoneIndex,
  knobs: Pick<IndexFetch, "gapBytes">,
): Range[] {
  const from = wanted.reduce((least, range) => Math.min(least, range.at), Number.POSITIVE_INFINITY);
  const furthest = (most: number, range: Range) => Math.max(most, range.at + range.length);
  const to = wanted.reduce(furthest, Number.NEGATIVE_INFINITY) + knobs.gapBytes;
  const near = stones.within(from, to);
  const wantedByAt = [...wanted].sort(byAt);
  const marked = mergedByAt(wantedByAt, near);
  const spans: Range[] = [];
  for (const group of coalesced(marked, knobs.gapBytes)) {
    const first = group.findIndex(({ isWanted }) => isWanted);
    if (first < 0) continue;
    let lastWanted = group.length - 1;
    while (!(group[lastWanted] as MarkedRange).isWanted) {
      lastWanted -= 1;
    }
    const lastAt = (group[lastWanted] as MarkedRange).range.at;
    let lastBefore = group.length - 1;
    while ((group[lastBefore] as MarkedRange).range.at > lastAt) {
      lastBefore -= 1;
    }
    const kept = group.slice(first, lastBefore + 2);
    const at = (kept[0] as MarkedRange).range.at;
    const through = kept.reduce((most, { range }) => furthest(most, range), at);
    spans.push({ at, length: through - at });
  }
  return spans;
}

export function windowPool(slotBytes: number, slots: number): WindowPool {
  const free: Uint8Array[] = [];
  let unbuilt = slotBytes >= LARGE_READ_BYTES ? slots : 0;
  const lease = (slot: Uint8Array, width: number): Lease => {
    const release = () => {
      free.push(slot);
    };
    return { bytes: slot.subarray(0, width), release };
  };
  const borrow = (width: number) => {
    if (width < LARGE_READ_BYTES || width > slotBytes) return null;
    let slot = free.pop() ?? null;
    if (slot === null && unbuilt > 0) {
      unbuilt -= 1;
      const owned = new ArrayBuffer(slotBytes);
      slot = new Uint8Array(owned);
    }
    return slot === null ? null : lease(slot, width);
  };
  return { borrow };
}

/** The one place a `Source` is read. */
export async function windowAt(
  { source, fileSize }: SizedSource,
  at: number,
  length: number,
  signal: AbortSignal | undefined,
  into?: Uint8Array,
): Promise<Window> {
  stopIfAborted(signal);
  const bytes = await source.read(at, length, into, signal);
  return { at, bytes, fileSize };
}

interface MarkedRange {
  range: Range;
  isWanted: boolean;
}

const MAX_SPAN_BYTES = 4 * 1024 ** 2;

const byAt = (a: Range, b: Range): number => a.at - b.at;

function firstAtOrAfter(sorted: readonly Range[], at: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as Range).at < at) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function mergedByAt(wanted: readonly Range[], stones: readonly Range[]): MarkedRange[] {
  const marked: MarkedRange[] = [];
  let w = 0;
  let s = 0;
  while (w < wanted.length || s < stones.length) {
    const range = wanted[w];
    const stone = stones[s];
    if (range !== undefined && (stone === undefined || range.at <= stone.at)) {
      marked.push({ range, isWanted: true });
      w += 1;
    } else {
      marked.push({ range: stone as Range, isWanted: false });
      s += 1;
    }
  }
  return marked;
}

function coalesced(sorted: readonly MarkedRange[], gapBytes: number): MarkedRange[][] {
  const groups: MarkedRange[][] = [];
  let start = 0;
  let end = 0;
  for (const marked of sorted) {
    const { at, length } = marked.range;
    const reach = Math.max(end, at + length);
    const last = groups.at(-1);
    if (last !== undefined && at - end <= gapBytes && reach - start <= MAX_SPAN_BYTES) {
      last.push(marked);
      end = reach;
      continue;
    }
    groups.push([marked]);
    start = at;
    end = at + length;
  }
  return groups;
}
