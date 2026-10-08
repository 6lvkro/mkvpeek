import { available, type Source, type Trip } from "./source.js";

export interface BlobOptions {
  /** Unset, `local`. */
  trip?: Trip;
}

/**
 * A source over a `Blob`, such as a picked `File`, read as on a local disk.
 *
 * WARN: a file on a network share wants `trip: "mount"`, or a walk reads nearly all of it over the link.
 */
export function blobSource(blob: Blob, options: BlobOptions = {}): Source {
  const read: Source["read"] = async (at, length) => {
    const bounded = available(at, length, blob.size);
    const buffer = await blob.slice(at, at + bounded).arrayBuffer();
    return new Uint8Array(buffer);
  };
  return { size: () => Promise.resolve(blob.size), read, trip: options.trip ?? "local" };
}
