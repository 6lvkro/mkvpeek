/**
 * The ContentEncodings a track states, and how to undo them.
 *
 * zlib and header stripping are undone; encryption and the other compressions are not.
 */

import { type Inflate, MAX_INFLATED_BYTES } from "../io/source.js";

export interface ContentEncoding {
  order: number;
  scope: number;
  /** null for an encryption, or for a type this reader does not know. */
  compression: ContentCompression | null;
}

export interface ContentCompression {
  algo: number;
  /** For header stripping, the bytes taken off the front of every frame. */
  settings: Uint8Array | null;
}

/** Its answer is a buffer of its own. */
export type Undo = (stored: Uint8Array) => Promise<Uint8Array>;

/** The ContentEncodingScope bit that covers the frames. */
export const FRAMES_SCOPE = 1;

/** The ContentCompAlgo a ContentCompression means when it states none. */
export const ZLIB_ALGO = 0;

export function undoFor(
  encodings: readonly ContentEncoding[] | null,
  scope: number,
  inflate: Inflate,
): Undo | null | false {
  if (encodings === null || encodings.some(reachesPastKnownScopes)) return false;
  const covering = encodings.filter((encoding) => (encoding.scope & scope) !== 0);
  const ordered = covering.sort((a, b) => b.order - a.order);
  const steps = ordered.map((encoding) => stepOf(encoding, inflate));
  const undos = steps.filter((step) => step !== null);
  if (undos.length < steps.length) return false;
  if (undos.length === 0) return null;
  return async (stored) => {
    const most = Math.min(MAX_INFLATED_BYTES, MAX_AMPLIFICATION * stored.length);
    let bytes = stored;
    for (const undo of undos) {
      bytes = await undo(bytes, most);
    }
    return bytes;
  };
}

/** A stated compression that does not inflate counts as one this reader cannot undo. */
export async function codecPrivateOf(
  stated: Uint8Array | null,
  encodings: readonly ContentEncoding[] | null,
  inflate: Inflate,
): Promise<Uint8Array | null> {
  if (stated === null) return null;
  const undo = undoFor(encodings, CODEC_PRIVATE_SCOPE, inflate);
  if (undo === null) return stated;
  if (undo === false) return null;
  return undo(stated).catch(() => null);
}

const HEADER_STRIPPING_ALGO = 3;

/** The ContentEncodingScope bit that covers CodecPrivate. */
const CODEC_PRIVATE_SCOPE = 2;

const KNOWN_SCOPES = FRAMES_SCOPE | CODEC_PRIVATE_SCOPE;

/** How many times its stored bytes a stream may be undone to, under {@linkcode MAX_INFLATED_BYTES}. */
const MAX_AMPLIFICATION = 64;

const reachesPastKnownScopes = ({ scope }: ContentEncoding): boolean =>
  (scope & ~KNOWN_SCOPES) !== 0;

function stepOf({ compression }: ContentEncoding, inflate: Inflate): Inflate | null {
  if (compression?.algo === ZLIB_ALGO) return inflate;
  if (compression?.algo !== HEADER_STRIPPING_ALGO) return null;
  const stripped = compression.settings ?? new Uint8Array(0);
  return (stored, most) => {
    const length = stripped.length + stored.length;
    if (length > most) return Promise.reject(new Error());
    const whole = new Uint8Array(length);
    whole.set(stripped, 0);
    whole.set(stored, stripped.length);
    return Promise.resolve(whole);
  };
}
