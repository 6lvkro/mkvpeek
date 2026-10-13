import type { Frame } from "../frames/contract.js";
import type { Assembler, Spool } from "./spool.js";

export function startSup(out: Spool): Assembler {
  const add = (frame: Frame) => {
    const head = supHead(Math.round(frame.startMs * SUP_TICKS_PER_MS));
    for (const segment of segmentsOf(frame.data)) {
      out.put(head);
      out.put(segment);
    }
  };
  return { add };
}

/** "PG", then the PTS and the DTS, ahead of each segment of a .sup file. */
const SUP_HEAD_BYTES = 10;

const SUP_MAGIC = 0x5047;

const SUP_TICKS_PER_MS = 90;

/** A PGS segment's type and its 16-bit size. */
const SEGMENT_HEAD_BYTES = 3;

function supHead(ticks: number): Uint8Array {
  const head = new Uint8Array(SUP_HEAD_BYTES);
  const view = new DataView(head.buffer);
  view.setUint16(0, SUP_MAGIC);
  view.setUint32(2, ticks);
  view.setUint32(6, ticks);
  return head;
}

/** A PGS frame's whole segments, leaving out what follows the last of them. */
function segmentsOf(data: Uint8Array): Uint8Array[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const segments: Uint8Array[] = [];
  let at = 0;
  while (data.length - at >= SEGMENT_HEAD_BYTES) {
    const end = at + SEGMENT_HEAD_BYTES + view.getUint16(at + 1);
    if (end > data.length) break;
    segments.push(data.subarray(at, end));
    at = end;
  }
  return segments;
}
