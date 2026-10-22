import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { fetchedOptional, type Segment } from "./chain.js";
import type { OpenedSegment } from "./header.js";

/** Each track's cue points, by TrackNumber. */
export type CueIndex = Map<number, CuePosition[]>;

export interface CuePosition {
  clusterPos: number;
  relPos: number;
  ticks: number | null;
}

export function readCues(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<CueIndex> {
  const located = { ...opened, signal };
  const parseCuesIn = (window: Window, el: Element) => parseCues(window, el, opened.segment);
  const noCues: CueIndex = new Map();
  return fetchedOptional(located, E.ID.segment.CUES, noCues, parseCuesIn);
}

function parseCues(window: Window, cues: Element, segment: Segment): CueIndex {
  const byTrack: CueIndex = new Map();
  const { bytes } = window;
  // The child walk is unrolled by hand.
  // With a cue point per subtitle frame, an object per element is the cost.
  const startOf = (at: number, need: number) => {
    const start = at - window.at;
    if (start < 0 || start + need > bytes.length) throw new E.GrammarError();
    return start;
  };
  const cursor = { id: 0, body: 0, next: 0 };
  const readElementHeader = (at: number, end: number) => {
    const idStart = startOf(at, 1);
    const idLength = E.vintLength(bytes[idStart] as number);
    if (idLength > E.MAX_VINT_BYTES) throw new E.GrammarError();
    startOf(at, idLength);
    cursor.id = E.vintValue(bytes, idStart, idLength, "id");
    const sizeAt = at + idLength;
    const sizeStart = startOf(sizeAt, 1);
    const sizeLength = E.vintLength(bytes[sizeStart] as number);
    if (sizeLength > E.MAX_VINT_BYTES) throw new E.GrammarError();
    startOf(sizeAt, sizeLength);
    cursor.body = sizeAt + sizeLength;
    cursor.next = cursor.body + E.vintValue(bytes, sizeStart, sizeLength, "size");
    if (cursor.next > end) throw new E.GrammarError();
  };
  const cursorUint = () => {
    const size = cursor.next - cursor.body;
    const start = startOf(cursor.body, size);
    return E.uintValue(bytes, start, size);
  };
  const pointTicks = (body: number, next: number) => {
    let fieldAt = body;
    while (fieldAt < next) {
      readElementHeader(fieldAt, next);
      if (cursor.id === E.ID.cue.TIME) return cursorUint();
      fieldAt = cursor.next;
    }
    return null;
  };
  const end = cues.body + cues.size;
  let at = cues.body;
  while (at < end) {
    readElementHeader(at, end);
    const pointId = cursor.id;
    const pointBody = cursor.body;
    const pointNext = cursor.next;
    if (pointId === E.ID.cue.POINT) {
      const ticks = pointTicks(pointBody, pointNext);
      let fieldAt = pointBody;
      while (fieldAt < pointNext) {
        readElementHeader(fieldAt, pointNext);
        const fieldId = cursor.id;
        const fieldBody = cursor.body;
        const fieldNext = cursor.next;
        if (fieldId === E.ID.cue.TRACK_POSITIONS) {
          let trackNumber = 0;
          let clusterPos = 0;
          let relPos = 0;
          let itemAt = fieldBody;
          while (itemAt < fieldNext) {
            readElementHeader(itemAt, fieldNext);
            const itemId = cursor.id;
            const value = cursorUint();
            if (itemId === E.ID.cue.TRACK) {
              trackNumber = value;
            } else if (itemId === E.ID.cue.CLUSTER_POSITION) {
              clusterPos = value;
            } else if (itemId === E.ID.cue.RELATIVE_POSITION) {
              relPos = value;
            }
            itemAt = cursor.next;
          }
          const position: CuePosition = { clusterPos: segment.body + clusterPos, relPos, ticks };
          const list = byTrack.get(trackNumber);
          if (list === undefined) byTrack.set(trackNumber, [position]);
          else list.push(position);
        }
        fieldAt = fieldNext;
      }
    }
    at = pointNext;
  }
  return byTrack;
}
