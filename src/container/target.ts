import { memorySource } from "../io/memory.js";
import type { Source } from "../io/source.js";
import { urlSource, whyCredentialed, whyInadmissible } from "../io/url.js";
import { type RefusalCode, RefusalError } from "../vocabulary.js";

/** A path (Node) or URL string, bytes in hand, or a {@linkcode Source} opened by the caller. */
export type Target = Source | ArrayBufferView | ArrayBuffer | string;

export type Opener = (target: string) => Promise<Source | RefusalCode>;

/** A source a target became, and how to let it go where something was opened for it. */
interface Lease {
  source: Source;
  release?(): Promise<void>;
}

export const urlRefusal = (parsed: URL): RefusalCode | null =>
  whyInadmissible(parsed) === null ? null : "invalid-target";

/** Opens a string target that can only be a URL. */
export const viaUrl: Opener = async (target) => {
  const parsed = URL.parse(target);
  if (parsed === null) return "invalid-target";
  return urlRefusal(parsed) ?? urlSource(target);
};

/** The source a target names, opened if a string named it; a target that will not open throws its refusal. */
export async function leaseOf(target: Target, open: Opener): Promise<Lease> {
  if (typeof target !== "string") return { source: heldSource(target) };
  const parsed = URL.parse(target);
  const secret = parsed === null ? null : whyCredentialed(parsed);
  if (secret !== null) throw new RefusalError("invalid-target");
  const opened = await open(target);
  if (typeof opened === "string") throw new RefusalError(opened);
  const release = async () => {
    await opened.close?.().catch(() => {});
  };
  return { source: opened, release };
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
