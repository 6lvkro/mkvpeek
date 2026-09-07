import { available, lend, type Source, type Trip } from "./source.js";

export function memorySource(bytes: ArrayBufferView | ArrayBuffer): Source {
  const held = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const read: Source["read"] = async (at, length, into) => {
    const bounded = available(at, length, held.byteLength);
    const lent = lend(into, bounded);
    if (lent !== null) {
      lent.set(held.subarray(at, at + bounded));
      return lent;
    }
    return new Uint8Array(held.subarray(at, at + bounded));
  };
  return { size: () => Promise.resolve(held.byteLength), read, trip: "local" satisfies Trip };
}
