import type { AsyncDisposal } from "../disposal.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import type { Abortable, Attachment, ContainerInfo, Track } from "../vocabulary.js";

/**
 * A container opened for its tracks' frames.
 *
 * A structured clone of it carries the listing alone.
 */
export interface Container extends AsyncDisposal {
  // Declared here so that a hover shows these two as Container's.
  readonly tracks: Track[];
  readonly info: ContainerInfo;
  /** Read by the first call that asks, and kept. */
  attachments(options?: Abortable): Promise<Attachment[]>;
  /**
   * Whether `frames` reads this track, that is, a subtitle track in an encoding this reader undoes.
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

/** Every track a container lists, and its Info. */
export interface Listing {
  tracks: Track[];
  info: ContainerInfo;
}
