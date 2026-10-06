import { givenSignal, type Inflate, type Source, stopIfAborted } from "../io/source.js";
import { type OpenedSegment, openSegment, readAttachments, readInfo } from "../matroska/header.js";
import { refusalOf } from "../refusal.js";
import { allTracks, type Track } from "../tracks.js";
import { type Attachment, type ContainerInfo, type PeekCode, RefusalError } from "../vocabulary.js";
import type { PeekOptions, PeekOutcome } from "./contract.js";
import { leaseOf, type Opener, type Target } from "./target.js";

/** What the Node and browser entries do differently. */
export interface Platform {
  open: Opener;
  inflate: Inflate;
}

export async function peekWith(
  platform: Platform,
  target: Target,
  options: PeekOptions = {},
): Promise<PeekOutcome> {
  const { signal: given, info, attachments } = { ...options };
  const signal = givenSignal(given);
  const wants = { info: info === true, attachments: attachments === true };
  try {
    const lease = await leaseOf(target, platform.open);
    try {
      return await listed(lease.source, platform.inflate, wants, signal);
    } finally {
      await lease.release?.();
    }
  } catch (error) {
    const code = refusalOf(error, signal);
    const refused = { tracks: [], info: null, attachments: null };
    return outcomeOf(wants, refused, code);
  }
}

export async function segmentOf(
  source: Source,
  inflate: Inflate,
  signal: AbortSignal | undefined,
): Promise<OpenedSegment> {
  const opened = await openSegment(source, signal, inflate);
  if (typeof opened === "string") throw new RefusalError(opened);
  return opened;
}

interface Wants {
  info: boolean;
  attachments: boolean;
}

interface Listing {
  tracks: Track[];
  info: ContainerInfo | null;
  attachments: Attachment[] | null;
}

async function listed(
  source: Source,
  inflate: Inflate,
  wants: Wants,
  signal: AbortSignal | undefined,
): Promise<PeekOutcome> {
  const opened = await segmentOf(source, inflate, signal);
  const tracks = allTracks(opened);
  const info = wants.info ? await readInfo(opened, signal) : null;
  const attachments = wants.attachments ? await readAttachments(opened, signal) : null;
  stopIfAborted(signal);
  const listing = { tracks, info, attachments };
  return outcomeOf(wants, listing, "served");
}

function outcomeOf(
  wants: Wants,
  { tracks, info, attachments }: Listing,
  code: PeekCode,
): PeekOutcome {
  const infoPart = wants.info ? { info } : {};
  const attachmentsPart = wants.attachments ? { attachments: attachments ?? [] } : {};
  return { tracks, ...infoPart, ...attachmentsPart, code };
}
