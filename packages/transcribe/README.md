# @orphus/transcribe

Local speech-to-text dictation. Audio never leaves the machine: the model runs
on your CPU, and the transcript goes into the editor for you to read before you
send it.

Derived from [pi-transcribe](https://github.com/earendil-works/pi-transcribe)
(MIT). See [UPSTREAM.md](./UPSTREAM.md) for the pinned revision, what was taken,
and where the two diverge.

## Status

**Not bundled or enabled yet.** Everything above the native boundary is
implemented and tested; the native artifacts are not built in this repository.
The gate is deliberate — see the bottom of [native/ABI.md](./native/ABI.md).

Until those artifacts exist, both channels report the library is missing and
dictation is unavailable. That is fail-closed by design: an absent native
library should look like an absent feature, not a crash.

## The surface

| | |
| --- | --- |
| `/transcribe` | Start dictation; run it again to stop and transcribe |
| `Ctrl+Alt+Z` | The same action |
| `Esc` | Cancel, while recording or transcribing |

The transcript is **pasted into the editor and not submitted**. Dictation
produces a draft; a draft you have not read is not a message you meant to send.

First run asks which language you will speak, offers the models that cover it,
and shows each one's size and licence before anything downloads.

## How it runs

```
controller (state machine, no audio, no renderer)
    │
    ▼
ProtocolBackend  ── JSON Lines ──▶  worker  (Bun FFI, dedicated Worker)
                                └▶  helper (child process, same protocol)
    │
    ▼
native/<triple>/orphus_transcribe.{dylib,so,dll}   miniaudio + transcribe.cpp
```

The primary runtime is a dedicated Bun Worker that exclusively owns the model,
the transcription session, the microphone, the native ring buffer, and the
cancellation token. Transcription is a long CPU-bound native call; on the main
thread it would block the very UI whose Escape key is supposed to cancel it.

The fallback is a helper executable speaking the **same** JSON-Lines protocol on
stdin/stdout. It takes over automatically when FFI loading, ABI verification,
worker startup, or the health check fails — and the session is told which of
those happened, because a run quietly on the fallback is a run nobody can debug
later.

Before either is accepted it must report the ABI version this build expects and
the build hash of the artifact this release shipped. A library that exports the
right names is not necessarily the right library.

## Models

None ship inside Orphus. `src/catalog.ts` carries four curated entries, each
pinned to a commit with an exact size, SHA-256, and licence link. A download
asks first, is verified on size then hash, and a file failing either is deleted
rather than left where something might load it.

## Testing it

The fake is a **channel**, not a stand-in backend, so tests exercise the real
protocol client, the real ABI check, the real fallback ladder, and the real
cancellation path against a scripted peer:

```ts
import { createFakeChannel, ProtocolBackend } from "@orphus/transcribe";

const backend = new ProtocolBackend(createFakeChannel({ transcript: { text: "hello" } }));
await backend.initialize({ modelPath: "/m.gguf", language: "en", sampleRate: 16_000 });
```
