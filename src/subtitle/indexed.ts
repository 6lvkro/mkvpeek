import {
  available,
  type IndexFetch,
  type Range,
  type SizedSource,
  type Source,
  stopIfAborted,
  type Watch,
} from "../io/source.js";
import { coalesce, fetchRanges, fetchSpans, WindowIndex } from "../io/windows.js";
import { type ClusterMemo, planRanges, planShortfall, readFrame } from "../matroska/cues.js";
import type { CuePosition, IndexedHeader, TrackEntry } from "../matroska/header.js";
import { isNumbered, statedFrameCount } from "../tracks/subtitle.js";
import type { RefusalCode } from "../vocabulary.js";
import { type Event, eventOf, type Timeline } from "./assemble.js";
import { assembleTrack, planFrom, type ReadPlan, type TrackTexts } from "./conclude.js";

export async function readByIndex(
  source: Source,
  knobs: IndexFetch,
  header: IndexedHeader,
  watch: Watch,
): Promise<TrackTexts | RefusalCode> {
  const plan = planFrom(header);
  if (typeof plan === "string") return plan;
  const collected = await followIndex(source, knobs, header, plan, watch);
  if (!(collected instanceof Map)) return collected;
  const out = new Map<number, string>();
  for (const track of plan.wanted) {
    const events = collected.get(track.number) ?? [];
    const vouched = anchorless(events) ? "may-be-short" : "whole";
    const assembled = assembleTrack(track, events, vouched);
    if (typeof assembled === "string") return assembled;
    out.set(track.streamIndex, assembled.text);
  }
  return out;
}

interface PlannedCue {
  track: TrackEntry;
  numbered: boolean;
  cue: CuePosition;
}

interface PlannedRound {
  slice: PlannedCue[];
  cues: CuePosition[];
  spans: Range[];
  bytes: number;
}

interface TrackedEvent {
  track: number;
  event: Event;
}

interface RoundInvariants {
  sized: SizedSource;
  knobs: IndexFetch;
  timeline: Timeline;
  head: IndexedHeader["head"];
}

const FRAMES_PER_ROUND = 4096;

const unheld = (ranges: readonly Range[], headBytes: number, fileSize: number): Range[] =>
  ranges.flatMap((range) => {
    const length = available(range.at, range.length, fileSize);
    if (length === 0 || range.at + length <= headBytes) return [];
    return [{ at: range.at, length }];
  });

async function followIndex(
  source: Source,
  knobs: IndexFetch,
  header: IndexedHeader,
  plan: ReadPlan,
  watch: Watch,
): Promise<Map<number, Event[]> | RefusalCode> {
  const planned = planFrames(header, plan.wanted);
  if (!Array.isArray(planned)) return planned;
  const headBytes = header.head.bytes.length;
  const rounds: PlannedRound[] = [];
  for (let start = 0; start < planned.length; start += FRAMES_PER_ROUND) {
    const slice = planned.slice(start, start + FRAMES_PER_ROUND);
    const cues = slice.map((p) => p.cue);
    const wanted = planRanges(cues, knobs.cueAheadBytes);
    const bought = unheld(wanted, headBytes, header.fileSize);
    const spans = coalesce(bought, knobs);
    const beyondHead = (sum: number, span: Range) =>
      sum + (span.at + span.length - Math.max(span.at, headBytes));
    const round = { slice, cues, spans, bytes: spans.reduce(beyondHead, 0) };
    rounds.push(round);
  }
  const totalBytes = headBytes + rounds.reduce((sum, r) => sum + r.bytes, 0);
  watch.onProgress(headBytes, totalBytes);
  const round = {
    sized: { source, fileSize: header.fileSize },
    knobs,
    timeline: plan.timeline,
    head: header.head,
  };
  const progressBytes = { headBytes, totalBytes };
  const collected = await collectByRound(round, rounds, progressBytes, watch);
  if (!Array.isArray(collected)) return collected;
  return vouchedRuns(header, plan.wanted, collected);
}

function planFrames(
  header: IndexedHeader,
  wanted: readonly TrackEntry[],
): PlannedCue[] | RefusalCode {
  const planned: PlannedCue[] = [];
  for (const track of wanted) {
    const cues = header.cues.get(track.number);
    if (cues === undefined || cues.length === 0) {
      return "unreadable";
    }
    if (repeatedPosition(cues)) {
      return "unreadable";
    }
    const numbered = isNumbered(track);
    for (const cue of cues) planned.push({ track, numbered, cue });
  }
  planned.sort((a, b) => a.cue.clusterPos - b.cue.clusterPos || a.cue.relPos - b.cue.relPos);
  return planned;
}

function vouchedRuns(
  header: IndexedHeader,
  wanted: readonly TrackEntry[],
  collected: readonly TrackedEvent[],
): Map<number, Event[]> | RefusalCode {
  const out = new Map<number, Event[]>();
  for (const track of wanted) {
    const events = collected.filter((e) => e.track === track.number).map((e) => e.event);
    if (brokenRun(events)) return "unreadable";
    const frames = statedFrameCount(header, track);
    if (frames !== null && frames !== events.length) {
      return "unreadable";
    }
    if (frames === null && !isNumbered(track)) {
      return "unreadable";
    }
    if (frames === null && anchorless(events)) {
      return "unreadable";
    }
    out.set(track.number, events);
  }
  return out;
}

function repeatedPosition(cues: readonly CuePosition[]): boolean {
  const seen = new Map<number, Set<number>>();
  for (const { clusterPos, relPos } of cues) {
    const inCluster = seen.get(clusterPos);
    if (inCluster === undefined) {
      const first = new Set([relPos]);
      seen.set(clusterPos, first);
      continue;
    }
    if (inCluster.has(relPos)) return true;
    inCluster.add(relPos);
  }
  return false;
}

async function collectByRound(
  round: RoundInvariants,
  rounds: readonly PlannedRound[],
  { headBytes, totalBytes }: { headBytes: number; totalBytes: number },
  { onProgress, signal }: Watch,
): Promise<TrackedEvent[] | RefusalCode> {
  const events: TrackedEvent[] = [];
  let doneBytes = headBytes;
  for (const { slice, cues, spans, bytes } of rounds) {
    stopIfAborted(signal);
    const first = await fetchSpans(round.sized, spans, round.knobs.concurrency, signal);
    const index = new WindowIndex(first, round.head);
    const missing = planShortfall(index, cues);
    const shortfall = unheld(missing, headBytes, round.sized.fileSize);
    const rest = await fetchRanges(round.sized, shortfall, round.knobs, signal);
    const windows = new WindowIndex([...first, ...rest], round.head);
    const roundEvents = await readRound(round.timeline, windows, slice);
    if (!Array.isArray(roundEvents)) return roundEvents;
    events.push(...roundEvents);
    doneBytes += bytes;
    onProgress(doneBytes, totalBytes);
  }
  stopIfAborted(signal);
  return events;
}

async function readRound(
  timeline: Timeline,
  windows: WindowIndex,
  planned: readonly PlannedCue[],
): Promise<TrackedEvent[] | RefusalCode> {
  const events: TrackedEvent[] = [];
  const memo: ClusterMemo = { last: null };
  for (const { track, numbered, cue: point } of planned) {
    const frame = await readFrame(windows, point, track.number, numbered, memo);
    if (typeof frame === "string") return "unreadable";
    const attributed = { track: track.number, event: eventOf(frame, timeline) };
    events.push(attributed);
  }
  return events;
}

function anchorless(events: readonly Event[]): boolean {
  return (
    events.length > 0 &&
    events.every((e) => e.readOrder !== null) &&
    !events.some((e) => e.readOrder === 0)
  );
}

function brokenRun(events: readonly Event[]): boolean {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let tally = 0;
  const distinct = new Set<number>();
  for (const { readOrder } of events) {
    if (readOrder === null) break;
    low = Math.min(low, readOrder);
    high = Math.max(high, readOrder);
    distinct.add(readOrder);
    tally += 1;
  }
  if (tally === events.length && tally > 0) {
    if (distinct.size !== tally) return true;
    if (high - low + 1 !== tally) return true;
  }
  return false;
}
