import * as E from "../ebml.js";

/** The ReadOrder an ASS frame leads with: ASCII digits, then a comma. */
export function readOrderOf(payload: Uint8Array): number | null {
  const end = payload.findIndex((byte) => byte < DIGIT_ZERO || byte > DIGIT_NINE);
  if (end < 1 || payload[end] !== COMMA) return null;
  const digits = payload.subarray(0, end);
  return Number(E.decodeUtf8(digits));
}

const DIGIT_ZERO = 0x30;

const DIGIT_NINE = 0x39;

const COMMA = 0x2c;
