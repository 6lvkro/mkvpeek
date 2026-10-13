import type { Frame } from "../frames/contract.js";
import { ENCODER } from "./text.js";

/** Writes a track's file into a spool, its head as soon as it starts. */
export interface Assembler {
  add(frame: Frame): void;
  end?(): void;
}

/**
 * A file's bytes in the order they are written, held until they are drained.
 *
 * Small writes are batched, so a line takes no array of its own.
 */
export class Spool {
  #pieces: Uint8Array[] = [];
  #texts: string[] = [];
  #chunk = new Uint8Array(0);
  #from = 0;
  #at = 0;
  #waiting = 0;

  /** The chunk the last `reserve` made room in. */
  get chunk(): Uint8Array {
    return this.#chunk;
  }

  /** What waits to be drained, a text counted by its length. */
  get waiting(): number {
    return this.#waiting;
  }

  /** Where `size` more bytes go in `chunk`. */
  reserve(size: number): number {
    this.#closeText();
    if (this.#chunk.length - this.#at < size) {
      this.#closeRun();
      this.#chunk = new Uint8Array(Math.max(CHUNK_BYTES, size));
      this.#from = 0;
      this.#at = 0;
    }
    const at = this.#at;
    this.#at += size;
    this.#waiting += size;
    return at;
  }

  write(text: string): void {
    this.#closeRun();
    this.#texts.push(text);
    this.#waiting += text.length;
  }

  /** A piece held as it is, for a file made of pieces alone. */
  put(piece: Uint8Array): void {
    this.#pieces.push(piece);
    this.#waiting += piece.length;
  }

  /** What was written since the last drain, as one array. */
  drain(): Uint8Array<ArrayBuffer> {
    this.#waiting = 0;
    const alone = this.#pieces.length === 0 && this.#at === this.#from;
    if (alone) return this.#encoded();
    this.#closeText();
    this.#closeRun();
    const pieces = this.#pieces;
    this.#pieces = [];
    this.#from = 0;
    this.#at = 0;
    if (this.#chunk.length > CHUNK_BYTES) {
      this.#chunk = new Uint8Array(0);
    }
    const size = pieces.reduce((total, piece) => total + piece.length, 0);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
      bytes.set(piece, at);
      at += piece.length;
    }
    return bytes;
  }

  #closeText(): void {
    if (this.#texts.length === 0) return;
    this.#pieces.push(this.#encoded());
  }

  #encoded(): Uint8Array<ArrayBuffer> {
    const text = this.#texts.join("");
    this.#texts = [];
    return ENCODER.encode(text);
  }

  #closeRun(): void {
    if (this.#at === this.#from) return;
    this.#pieces.push(this.#chunk.subarray(this.#from, this.#at));
    this.#from = this.#at;
  }
}

const CHUNK_BYTES = 64 * 1024;
