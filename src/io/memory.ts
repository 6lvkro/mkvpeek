import { available, type Source, type Trip } from "./source.js";

export function memorySource(bytes: ArrayBufferView | ArrayBuffer): Source {
  const held = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  // The reader never writes to the bytes it reads and hands out only copies.
  const read: Source["read"] = async (at, length) => {
    const bounded = available(at, length, held.byteLength);
    return held.subarray(at, at + bounded);
  };
  return { size: () => Promise.resolve(held.byteLength), read, trip: "local" satisfies Trip };
}
