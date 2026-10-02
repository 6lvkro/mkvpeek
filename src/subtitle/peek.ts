import type { IndexFetch, Source, WalkFetch, Watch } from "../io/source.js";
import { watchOver } from "../io/source.js";
import { type IndexedHeader, readContainer, type TimedHeader } from "../matroska/header.js";
import { absent, answerOf, type PeekOutcome, refused, served, wantsOf } from "../peek/contract.js";
import { fromHeader, returnedRefusal, thrownRefusal } from "../peek/engine.js";
import type { SubtitleTrack } from "../tracks/subtitle.js";
import { subtitleTracks } from "../tracks/subtitle.js";
import type { RefusalCode, SubtitleFinder, Wants } from "../vocabulary.js";
import type { TrackTexts } from "./conclude.js";
import { readByIndex } from "./indexed.js";
import { DEFAULT_VIA, type SubtitleOptions, type SubtitleVia } from "./options.js";
import { knobsForIndex, knobsForWalk } from "./tuning.js";
import { readByWalk } from "./walked.js";

export async function peekSubtitlesFrom(
  source: Source,
  options: SubtitleOptions = {},
): Promise<PeekOutcome<SubtitleTrack>> {
  // early return, no bodies
  if (options.text === false) return fromHeader(source, options, subtitleTracks);
  const viaAsked = options.via;
  const via =
    viaAsked !== undefined && Object.hasOwn(VIA_ROUTES, viaAsked) ? viaAsked : DEFAULT_VIA;
  const wants = wantsOf(options);
  let carried: TimedHeader | null = null;
  if (via === "index" || via === "both") {
    const indexed = await attempt(source, options, wants, INDEX);
    if (indexed.refusal === null) return enveloped(indexed, wants);
    // Even on `both`, stop here when a fallback is not worth it.
    const worthWalking = indexed.refusal === "unreadable" || indexed.refusal === "source-failed";
    if (via === "index" || !worthWalking) return enveloped(indexed, wants);
    carried = indexed.header;
  }
  const walked = await attempt(source, options, wants, WALK, carried);
  return enveloped(walked, wants);
}

type Attempt = Unopened | Opened;

/** An attempt that did not read the header. */
interface Unopened {
  refusal: RefusalCode;
  header: null;
}

/**
 * An attempt that read the header.
 *
 * Tracks come along even with a refusal.
 */
interface Opened {
  refusal: RefusalCode | null;
  header: TimedHeader;
  tracks: SubtitleTrack[];
}

interface FinderRoute<H extends TimedHeader, F extends { concurrency: number }> {
  open: (
    source: Source,
    wants: Wants,
    concurrency: number,
    signal: AbortSignal | undefined,
  ) => Promise<H | RefusalCode>;
  knobsFor: (source: Source, options: SubtitleOptions) => F;
  find: (source: Source, knobs: F, header: H, watch: Watch) => Promise<TrackTexts | RefusalCode>;
  finder: SubtitleFinder;
}

const VIA_ROUTES: Record<SubtitleVia, true> = { both: true, index: true, walk: true };

const INDEX: FinderRoute<IndexedHeader, IndexFetch> = {
  open: (source, wants, concurrency, signal) => {
    const readOptions = { ...wants, concurrency, signal };
    return readContainer(source, "indexed", readOptions);
  },
  knobsFor: knobsForIndex,
  find: readByIndex,
  finder: "index",
};

const WALK: FinderRoute<TimedHeader, WalkFetch> = {
  open: (source, wants, concurrency, signal) => {
    const readOptions = { ...wants, concurrency, signal };
    return readContainer(source, "timed", readOptions);
  },
  knobsFor: knobsForWalk,
  find: readByWalk,
  finder: "walk",
};

const tracksWith = (
  header: TimedHeader,
  text: TrackTexts | null,
  servedBy: SubtitleFinder | null,
): SubtitleTrack[] =>
  subtitleTracks(header).map((track) => {
    const body = text?.get(track.index) ?? null;
    return { ...track, text: body, servedBy: body === null ? null : servedBy };
  });

async function attempt<H extends TimedHeader, F extends { concurrency: number }>(
  source: Source,
  options: SubtitleOptions,
  wants: Wants,
  route: FinderRoute<H, F>,
  /** So the `both` fallback does not read the same header twice. */
  carried: H | null = null,
): Promise<Attempt> {
  const signal = options.signal;
  const listener = options.onProgress;
  const watch = watchOver(signal, (doneBytes, totalBytes) =>
    listener?.({ finder: route.finder, doneBytes, totalBytes }),
  );
  const knobs = route.knobsFor(source, options);
  const header =
    carried ??
    (await route
      .open(source, wants, knobs.concurrency, signal)
      .catch((error: unknown) => thrownRefusal(error, "malformed", signal)));
  if (typeof header === "string") return { refusal: returnedRefusal(header, signal), header: null };
  const listed = tracksWith(header, null, null);
  if (listed.every((track) => track.unsupported !== null)) {
    return { refusal: null, header, tracks: listed };
  }
  try {
    const texts = await route.find(source, knobs, header, watch);
    if (typeof texts === "string") {
      return { refusal: returnedRefusal(texts, signal), header, tracks: listed };
    }
    const tracks = tracksWith(header, texts, route.finder);
    return { refusal: null, header, tracks };
  } catch (error) {
    const refusal = thrownRefusal(error, "unreadable", signal);
    return { refusal, header, tracks: listed };
  }
}

function enveloped(tried: Attempt, wants: Wants): PeekOutcome<SubtitleTrack> {
  const absentAnswer = absent(wants);
  if (tried.header === null) return refused(tried.refusal, absentAnswer);
  const answer = answerOf(tried.header, tried.tracks, wants);
  if (tried.refusal === null) return served(answer);
  return refused(tried.refusal, answer);
}
