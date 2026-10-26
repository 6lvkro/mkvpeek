import * as E from "./ebml.js";
import { abortReason } from "./io/abort.js";
import { RefusalError } from "./vocabulary.js";

export function refusalOf(cause: unknown, signal: AbortSignal | undefined): RefusalError {
  if (abortReason(signal) !== null) return new RefusalError("cancelled");
  if (cause instanceof RefusalError) return cause;
  if (E.isGrammarError(cause)) return new RefusalError("malformed");
  return new RefusalError("source-failed", { cause });
}
