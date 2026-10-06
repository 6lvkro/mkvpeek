# mkvpeek

MKV tracks and subtitles in pure JavaScript, reading a fraction of the file.

```text
Measured on a 2.3 GB file on a local NVMe drive

ffprobe -show_streams video.mkv                      1.3 MB read   22 ms
peekTracks("video.mkv")                              135 KB read   0.9 ms

ffmpeg -i video.mkv -map 0:s:0 -c:s copy out.ass     2.3 GB read   659 ms
subtitleFile(firstSubtitle, frames)                  501 KB read   24 ms
```

mkvpeek is timed inside a running Node process, from the open to the first subtitle track written out; the two tools, from spawn to exit.

## When to use it

- You want the track list and the container info without an external demuxer
- You need to read a container in the browser with no WASM dependency
- The container sits on a server that allows Range requests
- You want a subtitle track, quickly and with fewer reads (or less transfer)

## Install

```sh
npm install mkvpeek
```

Node 22.1 or later, no other dependencies.
In the browser, `mkvpeek/browser` is the same reader minus file paths.

## Usage

```ts
import { peekTracks } from "mkvpeek";

// A file path (Node only), a URL whose server allows Range requests, or bytes
const { tracks, info } = await peekTracks("video.mkv");
```

```ts
import { writeFile } from "node:fs/promises";
import { openContainer, RefusalError, subtitleFiles } from "mkvpeek";

try {
  await using container = await openContainer("video.mkv");
  for (const { track, format, bytes } of await subtitleFiles(container)) {
    await writeFile(`${track.index}.${format}`, bytes);
  }
} catch (error) {
  if (!(error instanceof RefusalError)) throw error;
  // error.code says why
}
```

- `peekTracks` reads only the header, and answers every track with the container's `info`.
- `openContainer` keeps the file open for `frames`, `readable` and `attachments`, until `close` or the end of the `await using` block.
- `subtitleFiles` reads every ASS, SSA, SubRip and WebVTT track in one plan and writes each out; `formats` names others, such as `sup` for PGS.
- `subtitleFile` writes one track from its frames, in the format `subtitleFormat` names.
- A refusal is thrown as a `RefusalError`, whose `code` says why.

Node 22 runs `await using` only through a compiler such as TypeScript or esbuild.
In plain JavaScript there, close the container in a `finally`.

```ts
const container = await openContainer("video.mkv");
try {
  for (const { track, format, bytes } of await subtitleFiles(container)) {
    await writeFile(`${track.index}.${format}`, bytes);
  }
} finally {
  await container.close();
}
```

For request options such as headers, open the source with `urlSource`; whoever opens a source closes it.
Anything with `size` and `read` is a source too, such as one that reads a `File` as it goes.

```ts
import { openContainer, peekTracks, urlSource } from "mkvpeek";

await using source = await urlSource(url, { headers });
const { tracks } = await peekTracks(source);

const container = await openContainer({
  size: () => Promise.resolve(file.size),
  read: async (at, n) => new Uint8Array(await file.slice(at, at + n).arrayBuffer()),
});
```

## Constraints and read path selection

Frames are, for now, the subtitle tracks' alone. Where a track's frames are stored encoded, it undoes `zlib` and `header stripping`, and refuses a read of any other encoding, or of another kind of track, before it fetches a frame.

- By default the fast path (`index`) follows the file's `Cues` unless the file contradicts them, and then backs off to the slow path (`walk`), which visits every cluster.
- A short `Cues` list on a track that states no frame count can go unnoticed; `strict: true` trusts only what the file proves, at the cost of more reads.
- Only `walk` streams its frames; `index` vouches for all of them before handing any over.
- On a high-latency link `walk` loses its speed to round trips; downloading the file once and passing the bytes can be faster.
- A server has to answer a Range request with 206.

This reads fewer containers than the external tools, so where one is available, read by `index` and hand refused files to it.

```ts
import { openContainer, RefusalError, worthFallback } from "mkvpeek";

try {
  await using container = await openContainer(path);
  const subtitles = container.tracks.filter((track) => track.type === "subtitle");
  for await (const frame of container.frames(subtitles, { via: "index" })) use(frame);
} catch (error) {
  if (!(error instanceof RefusalError) || !worthFallback(error.code)) throw error;
  await demux(path);
}
```

## Compared with FFmpeg

Output is verified against ffprobe and ffmpeg, with four deliberate exceptions.

- **A track that states no `language`:** ffprobe emits `eng`; the package emits `null`.
- **A frame that states no `duration`, or zero:** ffmpeg may fill one in from a later frame; the package emits `null` or `0`.
- **A WebVTT block that does not split the way ffmpeg splits one:** ffmpeg drops the cue; the package keeps it.
- **Media that does not start where the first cluster does:** every timestamp differs from ffmpeg's by that gap.

Anything else the spec defines that a served read distorts or loses is a bug, apart from what a short `Cues` list hides by default; under `strict`, only these four remain.

## License

MIT
