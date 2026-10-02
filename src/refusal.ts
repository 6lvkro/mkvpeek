import * as E from "./ebml.js";
import { abortReason } from "./io/source.js";
import { type RefusalCode, RefusalError } from "./vocabulary.js";

/** The refusal a throw stands for, which is `cancelled` for any throw once the signal has fired. */
export function refusalOf(
  error: unknown,
  signal: AbortSignal | undefined,
  grammar: Extract<RefusalCode, "malformed" | "unreadable"> = "malformed",
): RefusalCode {
  if (error instanceof RefusalError) return returnedRefusal(error.code, signal);
  return returnedRefusal(E.isGrammarError(error) ? grammar : "source-failed", signal);
}

/** The refusal a read reached, or cancelled once its signal has fired: the caller stopped first. */
export function returnedRefusal(code: RefusalCode, signal: AbortSignal | undefined): RefusalCode {
  return abortReason(signal) !== null ? "cancelled" : code;
}
