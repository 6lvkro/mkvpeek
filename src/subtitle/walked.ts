import type { Source, WalkFetch, Watch } from "../io/source.js";
import { walkFrames } from "../matroska/clusters.js";
import type { TimedHeader } from "../matroska/header.js";
import { isNumbered } from "../tracks/subtitle.js";
import type { RefusalCode } from "../vocabulary.js";
import { eventOf } from "./assemble.js";
import { assembleTrack, planFrom, type TrackTexts } from "./conclude.js";

export async function readByWalk(
  source: Source,
  knobs: WalkFetch,
  header: TimedHeader,
  watch: Watch,
): Promise<TrackTexts | RefusalCode> {
  const plan = planFrom(header);
  if (typeof plan === "string") return plan;
  const { wanted, timeline } = plan;

  const pass = { source, segment: header.segment, head: header.head, signal: watch.signal };
  const numberedEntries = wanted.map((t) => [t.number, isNumbered(t)] as const);
  const numberedByTrack = new Map(numberedEntries);
  const framesByTrack = await walkFrames(pass, numberedByTrack, knobs, watch);
  if (framesByTrack === null) return "unreadable";

  const out = new Map<number, string>();
  for (const track of wanted) {
    const frames = framesByTrack.get(track.number);
    if (frames === undefined || frames.length === 0) return "unreadable";
    const events = frames.map((frame) => eventOf(frame, timeline));
    const assembled = assembleTrack(track, events, "whole");
    if (typeof assembled === "string") return assembled;
    out.set(track.streamIndex, assembled.text);
  }
  return out;
}
