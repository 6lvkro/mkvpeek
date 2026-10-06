import type { AsyncDisposal } from "../disposal.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import type { Track } from "../tracks.js";
import type { Abortable, Attachment, ContainerInfo, PeekCode } from "../vocabulary.js";

export interface PeekOptions extends Abortable {
  info?: boolean;
  attachments?: boolean;
}

/** A peek's answer, which carries a refusal rather than throwing it. */
export interface PeekOutcome<T extends Track = Track> {
  /** Empty on a refusal. */
  tracks: T[];
  info?: ContainerInfo | null;
  attachments?: Attachment[];
  code: PeekCode;
}

/**
 * A container opened for its tracks' frames.
 *
 * A structured clone of it carries the listing alone.
 */
export interface Container extends AsyncDisposal {
  readonly tracks: Track[];
  readonly info: ContainerInfo;
  /** Read by the first call that asks, and kept. */
  attachments(options?: Abortable): Promise<Attachment[]>;
  /**
   * Whether `frames` reads a track's type and its encodings,
   * as it reads no type other than subtitle and no frames stored in an encoding this reader does not undo.
   *
   * It throws a `TypeError` for a track that does not state, value for value, one of the tracks listed at the open.
   */
  readable(track: Track): boolean;
  /**
   * Reads the frames of the given tracks in one plan and in file order.
   *
   * Before a byte is read, it refuses a track that is not `readable`,
   * and throws a `TypeError` for a track that does not state, value for value, one of the tracks listed at the open.
   */
  frames(tracks: readonly Track[], options?: FrameOptions): AsyncIterableIterator<Frame>;
  /** Ends the reads still running as `cancelled` and closes what the open opened. */
  close(): Promise<void>;
}
