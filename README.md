# mkvpeek

[![npm](https://img.shields.io/npm/v/mkvpeek)](https://www.npmjs.com/package/mkvpeek)
[![demo](https://img.shields.io/badge/demo-try_it_in_your_browser-2ea44f)](https://atelier.6lvk.ro/mkvpeek/demo/)

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

| Reads | Chrome, Edge | Firefox | Safari |
| --- | --- | --- | --- |
| bytes or a `File` | 98 | 97 | 15.4 |
| a URL | 126 | 126 | 18 |
| a track compressed with zlib | 98 | 113 | 16.4 |

## Usage

```ts
import { peekTracks } from "mkvpeek";

// A file path (Node only), a URL whose server allows Range requests, or bytes
const { tracks, info } = await peekTracks("video.mkv");
```

```ts
import { openContainer, RefusalError, subtitleFiles } from "mkvpeek";

try {
  await using container = await openContainer("video.mkv");
  for (const { track, format, bytes } of await subtitleFiles(container)) use(track, format, bytes);
} catch (error) {
  if (!(error instanceof RefusalError)) throw error;
  // error.code says why
}
```

Node 22 runs `await using` only through a compiler such as TypeScript or esbuild.
In plain JavaScript there, close the container in a `finally`.

```ts
const container = await openContainer("video.mkv");
try {
  for (const { track, format, bytes } of await subtitleFiles(container)) use(track, format, bytes);
} finally {
  await container.close();
}
```

To write a track out as its frames come, rather than hold its file, use `subtitleStream`, or `subtitleStreams` for several tracks from one read.

Request options such as headers go through `urlSource`.

```ts
import { peekTracks, urlSource } from "mkvpeek";

await using source = await urlSource(url, { headers });
const { tracks } = await peekTracks(source);
```

## Constraints

- Frames are read from subtitle tracks only.
- Of the encodings a track's frames can be stored in, it undoes `zlib` and `header stripping`, and refuses any other.
- A server has to answer a Range request with 206.
- On a high-latency link the cluster-by-cluster `walk` loses its speed to round trips; downloading the file once and passing the bytes can be faster.

This reads fewer containers than the external tools, so where one is available, read by `index` and hand refused files to it.
A refusal can follow frames already handed over, so drop what was made of them before handing the file on.

```ts
import { openContainer, worthFallback } from "mkvpeek";

try {
  await using container = await openContainer(path);
  const subtitles = container.tracks.filter((track) => track.type === "subtitle");
  for await (const frame of container.frames(subtitles, { via: "index" })) use(frame);
} catch (error) {
  if (!worthFallback(error)) throw error;
  drop();
  await demux(path);
}
```

## Compared with FFmpeg

Output is verified against ffprobe and ffmpeg, with four deliberate exceptions.

- **A track that states no `language`:** ffprobe emits `eng`; the package emits `null`.
- **A frame that states no `duration`, or zero:** ffmpeg may fill one in from a later frame; the package emits `null` or `0`.
- **A WebVTT block that does not split the way ffmpeg splits one:** ffmpeg drops the cue; the package keeps it.
- **Media that does not start where the first cluster does:** every timestamp differs from ffmpeg's by that gap.

Anything else the spec defines that a served read distorts or loses is a bug, apart from what a short `Cues` list hides or a wrong `CueTime` misdates by default; under `strict`, only these four remain.

## License

MIT
