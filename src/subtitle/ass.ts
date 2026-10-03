import * as E from "../ebml.js";
import type { Witness, WitnessedFrame } from "../frames/claim.js";

export const SUBSTATION_CODECS: ReadonlySet<string> = new Set([
  "S_TEXT/ASS",
  "S_TEXT/SSA",
  "S_SSA",
  "S_ASS",
]);

/**
 * ReadOrders that run from 0 without a gap or a repeat are every frame of the track.
 *
 * A gap or a repeat means they cannot be.
 */
export const readOrderWitness: Witness = (frames) => {
  const orders = frames.map((frame) => readOrderOf(frame.payload));
  const known = orders.filter((order) => order !== null);
  if (known.length < orders.length) return null;
  const low = known.reduce((least, order) => Math.min(least, order));
  const high = known.reduce((most, order) => Math.max(most, order));
  const unbroken = new Set(known).size === known.length && high - low + 1 === known.length;
  if (!unbroken) return "broken";
  if (low === 0) return "whole";
  const front = frames[known.indexOf(low)] as WitnessedFrame;
  return (front.durationTicks ?? 0) === 0 ? "broken" : null;
};

const DIGIT_ZERO = 0x30;

const DIGIT_NINE = 0x39;

const COMMA = 0x2c;

/** The ReadOrder an ASS frame leads with: ASCII digits, then a comma. */
function readOrderOf(payload: Uint8Array): number | null {
  const end = payload.findIndex((byte) => byte < DIGIT_ZERO || byte > DIGIT_NINE);
  if (end < 1 || payload[end] !== COMMA) return null;
  const digits = payload.subarray(0, end);
  return Number(E.decodeUtf8(digits));
}
