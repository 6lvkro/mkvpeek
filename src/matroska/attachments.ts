import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { heldOrRead } from "../io/windows.js";
import type { Attachment } from "../vocabulary.js";
import { type Located, probed, readsAs } from "./chain.js";
import type { OpenedSegment } from "./header.js";
import { ID } from "./ids.js";

/** What each attached file states of itself, its bytes left where they are. */
export async function readAttachments(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<Attachment[]> {
  const located = { ...opened, signal };
  const at = located.offsets.get(ID.segment.ATTACHMENTS);
  if (at === undefined) return [];
  const window = await probed(located, at, located.head.fileSize, located.head);
  const attachmentsEl = E.readElement(window, at);
  if (!readsAs(attachmentsEl, ID.segment.ATTACHMENTS)) return [];
  const attachments: Attachment[] = [];
  const visit: Visit = async (_at, fileEl, held) => {
    if (fileEl.id !== ID.attachment.FILE) return held;
    const file = await readAttachedFile(located, fileEl, held);
    if (file === null) return null;
    attachments.push(file.file);
    return file.window;
  };
  const last = await eachChildIn(located, attachmentsEl, window, visit);
  return last === null ? [] : attachments;
}

/**
 * Looks at one child and hands back the window the next child's head is read from.
 *
 * null fails the whole walk.
 */
type Visit = (at: number, field: Element, window: Window) => Promise<Window | null>;

/** The most an attached file's name, type, description or UID may take; a larger one is skipped. */
const MAX_ATTACHED_FIELD_BYTES = 4096;

/**
 * The runaway cap of an attachment walk.
 *
 * The list and the walk inside each file count apart, so the worst case is their product.
 */
const MAX_ATTACHMENT_CHILDREN = 4096;

async function readAttachedFile(
  located: Located,
  fileEl: Element,
  held: Window,
): Promise<{ file: Attachment; window: Window } | null> {
  const out: Attachment = {
    fileName: null,
    mimeType: null,
    description: null,
    at: null,
    size: 0,
    uid: null,
  };
  const visit: Visit = async (at, field, held) => {
    if (field.id === ID.attachment.FILE_DATA) {
      out.at = field.body;
      out.size = field.size;
      return held;
    }
    if (field.next - at > MAX_ATTACHED_FIELD_BYTES) return held;
    const window = await heldOrRead(located.source, held, at, field.next - at, located.signal);
    if (field.id === ID.attachment.FILE_NAME) {
      out.fileName = E.readUtf8(window, field);
    } else if (field.id === ID.attachment.FILE_MIME) {
      out.mimeType = E.readAscii(window, field);
    } else if (field.id === ID.attachment.FILE_DESCRIPTION) {
      out.description = E.readUtf8(window, field);
    } else if (field.id === ID.attachment.FILE_UID) {
      out.uid = E.readUid(window, field);
    }
    return window;
  };
  const last = await eachChildIn(located, fileEl, held, visit);
  return last === null ? null : { file: out, window: last };
}

/**
 * Null past the bound.
 *
 * A child that does not read or that runs past its parent ends the walk, which answers its last window.
 */
async function eachChildIn(
  located: Located,
  parent: Element,
  held: Window,
  visit: Visit,
): Promise<Window | null> {
  let window = held;
  let pos = parent.body;
  let children = 0;
  while (pos < parent.next) {
    children += 1;
    if (children > MAX_ATTACHMENT_CHILDREN) return null;
    window = await probed(located, pos, parent.next, window);
    const field = E.readElement(window, pos);
    if (!E.fits(field, parent.next)) return window;
    const nextWindow = await visit(pos, field, window);
    if (nextWindow === null) return null;
    window = nextWindow;
    pos = field.next;
  }
  return window;
}
