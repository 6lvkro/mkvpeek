import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { fetchedOptional, type Segment } from "./chain.js";
import type { OpenedSegment } from "./header.js";
import { ID } from "./ids.js";

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
  return fetchedOptional(located, ID.segment.CUES, noCues, parseCuesIn);
}

function parseCues(window: Window, cues: Element, segment: Segment): CueIndex {
  const byTrack: CueIndex = new Map();
  // Every subtitle frame has a cue point, so each head is read into one cursor rather than an object per element.
  const cursor = E.elementCursor();
  const readElementHeader = (at: number, end: number) => {
    if (!E.fitsInto(window, at, end, cursor)) throw new E.GrammarError();
  };
  const cursorUint = () => E.readUintAt(window, cursor.body, cursor.next - cursor.body);
  const pointTicks = (body: number, next: number) => {
    let fieldAt = body;
    while (fieldAt < next) {
      readElementHeader(fieldAt, next);
      if (cursor.id === ID.cue.TIME) return cursorUint();
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
    if (pointId === ID.cue.POINT) {
      const ticks = pointTicks(pointBody, pointNext);
      let fieldAt = pointBody;
      while (fieldAt < pointNext) {
        readElementHeader(fieldAt, pointNext);
        const fieldId = cursor.id;
        const fieldBody = cursor.body;
        const fieldNext = cursor.next;
        if (fieldId === ID.cue.TRACK_POSITIONS) {
          let trackNumber = 0;
          let clusterPos = 0;
          let relPos = 0;
          let itemAt = fieldBody;
          while (itemAt < fieldNext) {
            readElementHeader(itemAt, fieldNext);
            const itemId = cursor.id;
            const value = cursorUint();
            if (itemId === ID.cue.TRACK) {
              trackNumber = value;
            } else if (itemId === ID.cue.CLUSTER_POSITION) {
              clusterPos = value;
            } else if (itemId === ID.cue.RELATIVE_POSITION) {
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
