# mkvpeek

MKV tracks and subtitles in pure JavaScript, reading a fraction of the file.

```text
Measured on a 2.3 GB file on a local NVMe drive

ffprobe -show_streams video.mkv                      1.3 MB read   22 ms
peekTracks("video.mkv")                              135 KB read   0.9 ms

ffmpeg -i video.mkv -map 0:s:0 -c:s copy out.ass     2.3 GB read   659 ms
subtitleFile(firstSubtitle, frames)                  501 KB read   24 ms
```

The mkvpeek lines are timed in a Node process that is already running, the second from opening the file to writing its first subtitle track out; the two tools, from being spawned to their exit.

It performs well when both hold: a low-latency link and the fast path (see [path selection](#constraints-and-read-path-selection)).

## When to use it

- You want the track list and the container info without an external demuxer
- You need to read a container in the browser with no WASM dependency
- The container sits on a server that allows Range requests
- You want a subtitle track, quickly and with fewer reads (or less transfer)

A frame is what the track stored, in its own format: an ASS line as its block holds it, a PGS display set, a WebVTT cue's three parts.

## Install

```sh
npm install mkvpeek
```

Node 22.1 or later, no other dependencies.

## Usage

There are two entry points: `peekTracks` and `openContainer`.

`peekTracks` reads only the header and returns every kind of track in `tracks`, and `info` and `attachments` when asked for. It answers a refusal with a `code` instead of throwing.

```ts
import { peekTracks } from "mkvpeek";

// A file path (Node only), a URL whose server allows Range requests, or bytes
const { code, tracks, info } = await peekTracks("video.mkv", { info: true });
// code is "served" unless refused
```

`openContainer` reads the same header and keeps the file open, so the frames of the tracks you pick are read in one plan, and the attachments when you ask for them.

```ts
import { writeFile } from "node:fs/promises";
import { openContainer, RefusalError, subtitleFiles } from "mkvpeek";

try {
  const container = await openContainer("video.mkv");
  try {
    for (const { track, format, text } of await subtitleFiles(container)) {
      await writeFile(`${track.index}.${format}`, text);
    }
  } finally {
    await container.close();
  }
} catch (error) {
  if (!(error instanceof RefusalError)) throw error;
  // error.code says why
}
```

`subtitleFiles` reads, in one plan, every ASS, SSA, SubRip or WebVTT track of `container.tracks` that `subtitleFile` can write and `readable` answers true for, and writes each one out.
It asks `frames` for no other track, and writes nothing where the read is refused.
For any other choice of tracks, `frames` reads the tracks you pass, `readable` says which types and encodings it reads, and `subtitleFile` writes one track out from the frames.

Where `await using` is available, it closes the container on the way out of the block.

```ts
await using container = await openContainer("video.mkv");
for (const { track, format, text } of await subtitleFiles(container)) {
  await writeFile(`${track.index}.${format}`, text);
}
```

For options the package cannot predefine, open the source yourself; whoever opens it closes it.

```ts
import { peekTracks, urlSource } from "mkvpeek";

const source = await urlSource(url, { headers });
try {
  await peekTracks(source);
} finally {
  await source.close?.();
}
```

If the bytes are already in hand, just pass them. But **reading a file up front only to pass it in throws away the benefit of reading just what is needed**; the links where that is worth giving up are at the end of [path selection](#constraints-and-read-path-selection).

```ts
import { openContainer } from "mkvpeek/browser";

// A source that reads a File lazily
const container = await openContainer({
  size: () => Promise.resolve(file.size),
  read: async (at, n) => new Uint8Array(await file.slice(at, at + n).arrayBuffer()),
});
```

In the browser, `mkvpeek/browser` is the same reader minus file paths.

## Constraints and read path selection

Frames are, for now, the subtitle tracks' alone. Where a track's frames are stored encoded, it undoes `zlib` and `header stripping`, and refuses a read of any other encoding, or of another kind of track, before it fetches a frame.

Matroska containers usually carry `Cues`, a list of frame positions, but the list can be short or wrong.
So that a frame the caller asked for is not silently lost when the list falls short,
the default is to back off the fast path (`index`) and retry along the slow path (`walk`), which visits every cluster.
Only the slow path streams its frames; the fast path vouches for all of them before handing any over.

Even with `walk`, this handles fewer containers than the external tools, so where one is available, read by `index` explicitly and hand refused files to that tool; where `index` works, it is well ahead of the binaries in both speed and transfer.

```ts
import { openContainer, RefusalError, worthFallback } from "mkvpeek";

try {
  const container = await openContainer(path);
  try {
    const subtitles = container.tracks.filter((track) => track.type === "subtitle");
    for await (const frame of container.frames(subtitles, { via: "index" })) use(frame);
  } finally {
    await container.close();
  }
} catch (error) {
  if (!(error instanceof RefusalError) || !worthFallback(error.code)) throw error;
  await demux(path);
}
```

On a high-latency network link the slow path (`walk`) loses much of its speed to round trips,
so accepting the transfer, downloading the whole file once on the consumer side and passing the bytes can be faster.

The package does not provide a download path of its own, and it refuses any response to a Range request other than 206.

## Oracle

Expected output is verified against ffprobe and ffmpeg, and the deliberate exceptions are, so far, these four.

- **When a track does not state its `language`**
  ffprobe emits `eng` as a default; the package emits `null`.

- **When a frame states no `duration`, or states zero**
  ffmpeg may fill one in from a later frame; the package emits `null` or `0`.

- **When a WebVTT block does not split the way ffmpeg splits one**
  ffmpeg drops the cue; the package keeps it.

- **When a file's media does not start where its first cluster does**
  every timestamp differs from ffmpeg's by that gap.

If something the spec defines is distorted or lost in a non-refused return, outside these four, it can be treated as a bug.

## License

MIT
