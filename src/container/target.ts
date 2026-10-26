import { isHttpUrl, urlSource, whyCredentialed } from "../io/http.js";
import { memorySource } from "../io/memory.js";
import { available, type Source, TRIPS, type Trip } from "../io/source.js";
import { RefusalError } from "../vocabulary.js";

/** A path (Node) or URL string, bytes in hand, or a {@linkcode Source} opened by the caller. */
export type Target = Source | ArrayBufferView | ArrayBuffer | string;

export type Opener = (target: string) => Promise<Source>;

export interface TargetLease {
  source: LeasedSource;
  release?(): Promise<void>;
}

type LeasedSource = Source & { readonly trip: Trip };

export const viaUrl: Opener = async (target) => {
  if (!isHttpUrl(target)) throw new RefusalError("invalid-target");
  return urlSource(target);
};

export async function leaseOf(target: Target, open: Opener): Promise<TargetLease> {
  if (typeof target !== "string") return { source: guarded(heldSource(target)) };
  const parsed = URL.parse(target);
  const secret = parsed === null ? null : whyCredentialed(parsed);
  if (secret !== null) throw new RefusalError("invalid-target");
  const source = await open(target);
  const release = async () => {
    await source.close?.().catch(() => {});
  };
  return { source: guarded(source), release };
}

function guarded(source: Source): LeasedSource {
  // The reader asks the size before it reads, so a read before that is not measured against it.
  let fileSize = 0;
  const size: Source["size"] = async (signal) => {
    const answer: unknown = await fromSource(() => source.size(signal));
    if (!Number.isSafeInteger(answer) || (answer as number) < 0) {
      throw sourceFailed("answered a size that is no count of bytes");
    }
    fileSize = answer as number;
    return fileSize;
  };
  const read: Source["read"] = async (at, length, into, signal) => {
    const answer: unknown = await fromSource(() => source.read(at, length, into, signal));
    if (!ArrayBuffer.isView(answer) || (answer as Uint8Array).BYTES_PER_ELEMENT !== 1) {
      throw sourceFailed("answered a read with something other than bytes");
    }
    if (answer.byteLength < available(at, length, fileSize)) {
      throw sourceFailed("answered a read short of the bytes its size holds there");
    }
    // Held as a plain Uint8Array, since what is kept from a window is sliced out of it and a Buffer's slice is a view.
    return new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength);
  };
  return {
    size,
    read,
    // Read on every ask, so that a source that settles late still says its own trip.
    get trip() {
      const { trip } = source;
      return trip !== undefined && Object.hasOwn(TRIPS, trip) ? trip : "remote";
    },
  };
}

async function fromSource<T>(ask: () => T | Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (cause) {
    throw new RefusalError("source-failed", { cause });
  }
}

function sourceFailed(why: string): RefusalError {
  const cause = new Error(why);
  return new RefusalError("source-failed", { cause });
}

function heldSource(target: Exclude<Target, string>): Source {
  if (target instanceof ArrayBuffer || ArrayBuffer.isView(target)) {
    try {
      return memorySource(target);
    } catch {
      throw new RefusalError("invalid-target");
    }
  }
  const readsAndSizes =
    target !== null &&
    target !== undefined &&
    typeof target.read === "function" &&
    typeof target.size === "function";
  if (readsAndSizes) return target;
  throw new RefusalError("invalid-target");
}
