import { open, statfs } from "node:fs/promises";

import { available, LARGE_READ_BYTES, lend, type Source } from "./source.js";

export async function fileSource(path: string): Promise<Source> {
  const handle = await open(path, "r");
  const local = await isLocalDisk(path);
  let cached: number | null = null;
  const size = async (): Promise<number> => {
    cached ??= (await handle.stat()).size;
    return cached;
  };
  const read = async (at: number, length: number, into?: Uint8Array) => {
    const bounded = available(at, length, await size());
    const unzeroed = bounded >= LARGE_READ_BYTES;
    const lent = unzeroed ? lend(into, bounded) : null;
    const buffer = lent ?? (unzeroed ? Buffer.allocUnsafeSlow(bounded) : new Uint8Array(bounded));
    let filled = 0;
    while (filled < bounded) {
      const { bytesRead } = await handle.read(buffer, filled, bounded - filled, at + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
  };
  const close = () => handle.close();
  const trip = local ? "local" : "mount";
  return { size, read, close, trip };
}

const NETWORK_MAGIC: ReadonlySet<number> = new Set([
  0x6969, // NFS
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x517b, // SMB
  0x01021997, // 9P
  0x00c36400, // Ceph
  0x7461636f, // OCFS2
  0x5346414f, // AFS
  0x6b414653, // kAFS
]);

/** A guard whose only purpose is per-trip optimisation. */
async function isLocalDisk(path: string): Promise<boolean> {
  try {
    return !NETWORK_MAGIC.has((await statfs(path)).type);
  } catch {
    return true;
  }
}
