/**
 * The ContentEncodings a track states, and how to undo them.
 *
 * zlib and header stripping are undone; encryption and the other compressions are not.
 */

import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { type Inflate, MAX_INFLATED_BYTES } from "../io/source.js";

export interface ContentEncoding {
  order: number;
  scope: number;
  /** null for an encryption, or for a type this reader does not know. */
  compression: ContentCompression | null;
}

/** Its answer is a buffer of its own. */
export type Undo = (stored: Uint8Array) => Promise<Uint8Array>;

interface ContentCompression {
  algo: number;
  settings: Uint8Array | null;
}

/** The ContentEncodingScope bit that covers the frames. */
export const FRAMES_SCOPE = 1;

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

export function encodingsIn(window: Window, list: Element): ContentEncoding[] | null {
  try {
    const encodings: ContentEncoding[] = [];
    for (const el of E.children(window, list.body, list.size)) {
      if (el.id === E.ID.contentEncoding.ENCODING) {
        encodings.push(encodingOf(window, el));
      }
    }
    return encodings;
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
    return null;
  }
}

/** A stated compression that does not inflate counts as one this reader cannot undo. */
export async function codecPrivateOf(
  stored: Uint8Array | null,
  encodings: readonly ContentEncoding[] | null,
  inflate: Inflate,
): Promise<Uint8Array | null> {
  if (stored === null) return null;
  const undo = undoFor(encodings, CODEC_PRIVATE_SCOPE, inflate);
  if (undo === null) return stored;
  if (undo === false) return null;
  return undo(stored).catch(() => null);
}

/** The ContentCompAlgo a ContentCompression means when it states none. */
const ZLIB_ALGO = 0;

const HEADER_STRIPPING_ALGO = 3;

/** The ContentEncodingScope bit that covers CodecPrivate. */
const CODEC_PRIVATE_SCOPE = 2;

const KNOWN_SCOPES = FRAMES_SCOPE | CODEC_PRIVATE_SCOPE;

/** How many times its stored bytes a stream may be undone to, under {@linkcode MAX_INFLATED_BYTES}. */
const MAX_AMPLIFICATION = 64;

const COMPRESSION_TYPE = 0;

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

function encodingOf(window: Window, encodingEl: Element): ContentEncoding {
  let order = 0;
  let scope = FRAMES_SCOPE;
  let type = COMPRESSION_TYPE;
  let compression: ContentCompression = { algo: ZLIB_ALGO, settings: null };
  for (const field of E.children(window, encodingEl.body, encodingEl.size)) {
    const { id } = field;
    if (id === E.ID.contentEncoding.ORDER) {
      order = uintOf(window, field);
    } else if (id === E.ID.contentEncoding.SCOPE) {
      scope = uintOf(window, field);
    } else if (id === E.ID.contentEncoding.TYPE) {
      type = uintOf(window, field);
    } else if (id === E.ID.contentEncoding.COMPRESSION) {
      compression = compressionOf(window, field);
    }
  }
  return { order, scope, compression: type === COMPRESSION_TYPE ? compression : null };
}

function compressionOf(window: Window, compressionEl: Element): ContentCompression {
  let algo = ZLIB_ALGO;
  let settings: Uint8Array | null = null;
  for (const field of E.children(window, compressionEl.body, compressionEl.size)) {
    if (field.id === E.ID.contentEncoding.COMP_ALGO) {
      algo = uintOf(window, field);
    } else if (field.id === E.ID.contentEncoding.COMP_SETTINGS) {
      settings = E.readBytes(window, field.body, field.size).slice();
    }
  }
  return { algo, settings };
}

function uintOf(window: Window, field: Element): number {
  const value = E.readUint(window, field);
  if (value === null) throw new E.GrammarError();
  return value;
}
