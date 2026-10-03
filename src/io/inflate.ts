import type { Inflate } from "./source.js";

export const inflateByStream: Inflate = async (deflated, most) => {
  const inflating = new DecompressionStream("deflate");
  const writer = inflating.writable.getWriter();
  const owned = new Uint8Array(deflated);
  writer.write(owned).catch(() => {});
  writer.close().catch(() => {});
  const reader = inflating.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > most) {
      await reader.cancel();
      throw new Error();
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
};
