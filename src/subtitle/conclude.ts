import type { TimedHeader, TrackEntry } from "../matroska/header.js";
import { kindOf, type TrackType } from "../tracks/core.js";
import { isNumbered, isSupported, SUPPORTED_CODECS, subtitleEntries } from "../tracks/subtitle.js";
import type { RefusalCode } from "../vocabulary.js";
import { assembleAss, assembleSrt, assembleVtt, type Event, type Timeline } from "./assemble.js";

export type TrackTexts = Map<number, string>;

export interface ReadPlan {
  wanted: readonly TrackEntry[];
  timeline: Timeline;
}

interface TrackBody {
  text: string;
}

/**
 * Whether the events handed over can be shown to be every frame of the track.
 *
 * A list cut at the front looks whole and answers the first frame wrongly.
 */
type Completeness = "whole" | "may-be-short";

export function planFrom(header: TimedHeader): ReadPlan | RefusalCode {
  const wanted = subtitleEntries(header).filter(isSupported);
  const timeline = timelineOf(header);
  if (typeof timeline === "string") return timeline;
  return { wanted, timeline };
}

export function assembleTrack(
  track: TrackEntry,
  events: readonly Event[],
  completeness: Completeness,
): TrackBody | RefusalCode {
  const format = SUPPORTED_CODECS.get(track.codecId);
  const numbered = isNumbered(track);
  const ordered = orderedAndChecked(events, numbered, completeness);
  if (typeof ordered === "string") return ordered;
  if (format === "ass") return { text: assembleAss(track.codecPrivate, ordered) };
  if (format === "vtt") return { text: assembleVtt(ordered) };
  void (format satisfies "srt" | undefined);
  return { text: assembleSrt(ordered) };
}

const NS_PER_MS = 1_000_000;

const TIMELINE_KINDS: ReadonlySet<TrackType> = new Set(["video", "audio", "complex"]);

function timelineOf(header: TimedHeader): Timeline | RefusalCode {
  const shiftMs = timelineShift(header);
  if (shiftMs === null) {
    return "malformed";
  }
  return { msPerTick: header.info.timestampScale / NS_PER_MS, shiftMs };
}

function timelineShift(header: TimedHeader): number | null {
  const delayNs = header.trackEntries.reduce((most, t) => Math.max(most, t.codecDelayNs), 0);
  const delayMs = Math.round(delayNs / NS_PER_MS);
  if (!header.trackEntries.some((t) => TIMELINE_KINDS.has(kindOf(t)))) return delayMs;
  if (header.firstClusterTicks === null) return null;
  return delayMs - (header.firstClusterTicks * header.info.timestampScale) / NS_PER_MS;
}

/** ASS events go out in the muxer's ReadOrder, plain text in time order. */
function sortEvents(events: readonly Event[], numbered: boolean): Event[] {
  const ordered = [...events];
  if (numbered) ordered.sort((a, b) => (a.readOrder ?? 0) - (b.readOrder ?? 0));
  else ordered.sort((a, b) => a.startMs - b.startMs);
  return ordered;
}

function orderedAndChecked(
  events: readonly Event[],
  numbered: boolean,
  completeness: Completeness,
): Event[] | RefusalCode {
  const ordered = sortEvents(events, numbered);
  if (numbered && ordered.some((e) => e.readOrder === null)) return "malformed";
  if (completeness === "may-be-short" && ordered[0]?.durationMs === 0) return "unreadable";
  return ordered;
}
