import type { CueIndex } from "../matroska/cues.js";
import type { OpenedSegment } from "../matroska/header.js";
import type { Timeline } from "./timeline.js";

/** Its timeline and cues are bought when first asked. */
export interface FrameFile extends OpenedSegment {
  timeline(signal: AbortSignal): Promise<Timeline>;
  cues(signal: AbortSignal): Promise<CueIndex>;
}
