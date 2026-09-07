# mkvpeek

Looks at the tracks of a Matroska container without demuxing the whole of it.

```text
Measured on a 2.2 GB file on a local NVMe drive

ffprobe -show_streams video.mkv                      1.2 MB read   21 ms
peekTracks("video.mkv")                              135 KB read   0.6 ms

ffmpeg -i video.mkv -map 0:s:0 -c:s copy out.ass     2.2 GB read   609 ms
peekSubtitles("video.mkv")                           1.6 MB read   60 ms
```

The two `peek` lines are calls made from a Node process that is already running; the two tools are timed from being spawned as a subprocess to their exit.

It performs well when both hold: a low-latency link and the fast path (see [path selection](#constraints-and-read-path-selection)).

## When to use it

- You want the track list and the container info without an external demuxer
- You need to read a container in the browser with no WASM dependency
- The container sits on a server that allows Range requests
- You need a subtitle track as a whole, not as a stream of events
- You want a subtitle track extracted quickly, with fewer reads (or less transfer)

Assembling a body is, for now, the subtitle track's alone, and it supports the `ASS` / `SSA` / `SRT` / `VTT` formats.

## Install

```sh
npm install mkvpeek
```

Node 22.1 or later, no other dependencies.

## Usage

There are two entry points, and a refusal answers with a code instead of throwing.

`peekTracks` reads only the header and returns every kind of track; `peekSubtitles` returns subtitle tracks with their bodies.

```ts
import { peekSubtitles, peekTracks, urlSource } from "mkvpeek";

// A file path (Node only)
await peekTracks("video.mkv");
await peekSubtitles("video.mkv");

// A URL, when the server allows Range requests
await peekTracks("https://host/video.mkv");

// A Uint8Array or an ArrayBuffer
await peekTracks(bytes);

// For options the package cannot predefine, open the source yourself; whoever opens it closes it.
const source = await urlSource(url, { headers });
try {
  await peekTracks(source);
} finally {
  await source.close?.();
}
```

If the bytes are already in hand, just pass them.

But **reading a file up front only to pass it in throws away the benefit of reading just what is needed.**
The links where that benefit is worth giving up are discussed at the end of [path selection](#constraints-and-read-path-selection).

```ts
import { peekSubtitles } from "mkvpeek/browser";

// A source that reads a File lazily
await peekSubtitles({
  size: () => Promise.resolve(file.size),
  read: async (at, n) => new Uint8Array(await file.slice(at, at + n).arrayBuffer()),
});
```

In the browser, `mkvpeek/browser` is the same reader minus file paths.

## Constraints and read path selection

> The read path does not apply to `peekTracks`, which reads only the header; it applies only when subtitle bodies are involved.

Matroska containers usually carry `Cues`, a list of frame positions, but the list can be short or wrong.
So that a subtitle body the caller asked for is not silently lost when the list falls short,
the default is to back off the fast path (`index`) and retry along the slow path (`walk`), which visits every cluster.

Even with `walk`, though, the range of containers this handles falls short of the external tools.
If an external tool is available, the recommendation is to use the fast path (`index`) explicitly and hand refused files to that tool.
On containers where `index` works, both speed and transfer come out well ahead of the binaries, and that alone makes it worth it.

```ts
import { peekSubtitles, worthFallback } from "mkvpeek";

const { code, tracks } = await peekSubtitles(path, { via: "index" });
if (worthFallback(code)) await demux(path);
```

On a high-latency network link the slow path (`walk`) loses much of its speed to round trips,
so accepting the transfer, downloading the whole file once on the consumer side and passing the bytes can be faster.

The package does not provide a download path of its own, and it refuses any response to a Range request other than 206.

## Oracle

Expected output is verified against ffprobe and ffmpeg, and the deliberate exceptions are, so far, these two.

- **When a track does not state its `language`**
  ffprobe emits `eng` as a default; the package emits `null`.

- **When a frame in the body does not state its `duration`**
  ffmpeg uses a derived value; the package uses 0.

If something the spec defines is distorted or lost in a non-refused return, outside these two, it can be treated as a bug.

## License

MIT
