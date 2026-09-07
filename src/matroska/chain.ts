import type { Element, OpenElement, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { type Source, stopIfAborted } from "../io/source.js";
import { windowOver } from "../io/windows.js";

export interface Segment {
  /**
   * The absolute offset of the Segment's first child.
   *
   * Every Seek and Cue position is relative to it.
   */
  body: number;
  end: number;
}

export interface SegmentPass {
  source: Source;
  segment: Segment;
  head: Window;
  signal: AbortSignal | undefined;
}

/**
 * An element and the window its head was read from.
 *
 * For a cluster the window reaches the Timestamp.
 */
interface TopLevelHop {
  at: number;
  el: Element | OpenElement;
  window: Window;
}

/** Enough for any element's header. */
export const ELEMENT_HEADER_BYTES = 2 * E.MAX_VINT_BYTES;

/** Enough to read a cluster's header and its Timestamp. */
export const CLUSTER_PROBE_BYTES = 64;

/** The cluster children that carry frames. */
export const FRAME_IDS: ReadonlySet<number> = new Set([
  E.ID.cluster.SIMPLE_BLOCK,
  E.ID.cluster.BLOCK_GROUP,
]);

export const pastSegment = (el: Element, segment: Segment): boolean => el.next > segment.end;

export const headerNeed = (at: number, end: number): number =>
  Math.min(ELEMENT_HEADER_BYTES, end - at);

/**
 * The one door for reads past the head.
 *
 * The signal is asked here and nowhere else.
 */
export function readPastHead(
  pass: SegmentPass,
  at: number,
  length: number,
  held: Window,
): Promise<Window> {
  stopIfAborted(pass.signal);
  return windowOver(pass.source, at, length, held);
}

export async function* hopTopLevel(
  pass: SegmentPass,
  /**
   * The end of a sizeless cluster is the walk's discovery.
   *
   * The hop that resumes after it passes it here.
   */
  from = pass.segment.body,
): AsyncGenerator<TopLevelHop> {
  let pos = from;
  while (pos < pass.segment.end) {
    const window = await readPastHead(pass, pos, CLUSTER_PROBE_BYTES, pass.head);
    const el = E.readElement(window, pos);
    if (typeof el === "string") throw new E.GrammarError();
    const isOpen = "open" in el;
    if (isOpen ? el.id !== E.ID.segment.CLUSTER : pastSegment(el, pass.segment)) {
      throw new E.GrammarError();
    }
    yield { at: pos, el, window };
    if (isOpen) return;
    pos = el.next;
  }
}

/**
 * A cluster's Timestamp.
 *
 * In a sizeless cluster the search goes as far as the window reaches.
 */
export function readClusterTime(window: Window, cluster: Element | OpenElement): number | null {
  const end = "open" in cluster ? E.reachOf(window) : cluster.next;
  try {
    for (const field of E.children(window, cluster.body, end - cluster.body)) {
      if (field.id === E.ID.cluster.TIMESTAMP) return E.readUint(window, field);
      if (FRAME_IDS.has(field.id)) return null;
    }
  } catch {
    return null;
  }
  return null;
}
