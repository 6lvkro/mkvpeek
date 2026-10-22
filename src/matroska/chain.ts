import type { Element, OpenElement, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { available, type Source } from "../io/source.js";
import { windowAt } from "../io/windows.js";

export interface Located extends SegmentPass {
  offsets: Map<number, number>;
}

export interface SegmentPass {
  source: Source;
  segment: Segment;
  head: Window;
  signal: AbortSignal | undefined;
}

export interface Segment {
  /**
   * The absolute offset of the Segment's first child.
   *
   * Every Seek and Cue position is relative to it.
   */
  body: number;
  end: number;
}

/** For a cluster, the window reaches its Timestamp. */
interface TopLevelHop {
  at: number;
  el: Element | OpenElement;
  window: Window;
}

interface Fetched {
  window: Window;
  element: Element;
}

export const ELEMENT_HEADER_BYTES = 2 * E.MAX_VINT_BYTES;

/** Enough to read a cluster's header and its Timestamp. */
export const CLUSTER_PROBE_BYTES = 64;

export const pastSegment = (el: Element, segment: Segment): boolean => el.next > segment.end;

export const headerNeed = (at: number, end: number): number =>
  Math.min(ELEMENT_HEADER_BYTES, end - at);

export const readsAs = (el: ReturnType<typeof E.readElement>, id: number): el is Element =>
  E.decoded(el) && el.id === id;

export const fetchedOptional = <T>(
  located: Located,
  id: number,
  fallback: T,
  parse: (window: Window, element: Element) => T,
): Promise<T> =>
  optional(fallback, async () => {
    const fetched = await fetchElement(located, id);
    if (fetched === null) return fallback;
    return parse(fetched.window, fetched.element);
  });

export async function* hopTopLevel(
  pass: SegmentPass,
  /** A hop resumes past a sizeless cluster at the end the walk found. */
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

/** In a sizeless cluster the search goes as far as the window reaches. */
export function readClusterTicks(window: Window, cluster: Element | OpenElement): number | null {
  const end = "open" in cluster ? E.reachOf(window) : cluster.next;
  try {
    for (const field of E.children(window, cluster.body, end - cluster.body)) {
      if (field.id === E.ID.cluster.TIMESTAMP) return E.readUint(window, field);
    }
  } catch {
    return null;
  }
  return null;
}

export async function optional<T>(fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
    return fallback;
  }
}

export async function fetchElement(located: Located, id: number): Promise<Fetched | null> {
  const at = located.offsets.get(id);
  if (at === undefined) return null;
  return fetchAt(located, id, at);
}

export async function fetchAt(located: Located, id: number, at: number): Promise<Fetched | null> {
  const probe = await probed(located, at, located.head.fileSize, located.head);
  const header = E.readElement(probe, at);
  if (!readsAs(header, id)) return null;
  if (header.next - at > MAX_FETCHED_ELEMENT_BYTES) return null;
  const window = await readPastHead(located, at, header.next - at, probe);
  return { window, element: header };
}

export function probed(located: Located, at: number, limit: number, held: Window): Promise<Window> {
  const need = headerNeed(at, limit);
  if (E.covers(held, at, need)) return Promise.resolve(held);
  const width = Math.min(ELEMENT_PROBE_BYTES, limit - at);
  return readPastHead(located, at, width, held);
}

export async function readPastHead(
  pass: SegmentPass,
  at: number,
  length: number,
  held: Window,
): Promise<Window> {
  const need = available(at, length, held.fileSize);
  if (E.covers(held, at, need)) return held;
  const sized = { source: pass.source, fileSize: held.fileSize };
  return windowAt(sized, at, length, pass.signal);
}

const ELEMENT_PROBE_BYTES = 4096;

const MAX_FETCHED_ELEMENT_BYTES = 64 * 1024 ** 2;
