# Upstream sync record

`@orphus/transcribe` is derived from
[pi-transcribe](https://github.com/earendil-works/pi-transcribe), MIT licensed.
The copyright line for Earendil Works contributors is kept in `LICENSE`
alongside ours.

This file is the record of what was taken and where the two have diverged. Keep
it accurate: a fork whose provenance is folklore is a fork nobody can audit or
resync.

## Pinned revision

| | |
| --- | --- |
| Repository | `https://github.com/earendil-works/pi-transcribe` |
| Revision | `45924bd491e5ee2655d4269aa504eab11e27a424` |
| Subject | `change default shortcut + slightly improve dl` |
| Reviewed | 2026-08-18 |

## What was taken

- **The UX shape.** `/transcribe`, a keyboard shortcut that toggles recording,
  first-run language-and-model setup, an explicit confirmation before a model
  downloads, Escape to cancel, and inserting the transcript into the editor
  without submitting it. These are the behaviours worth keeping, and they are
  reimplemented here rather than copied line for line.
- **Catalog data.** Model repository, pinned revision, filename, exact size, and
  SHA-256 for the four entries in `src/catalog.ts` are transcribed from
  upstream's `catalog/catalog.json` at the revision above. Licence links were
  added here.

## Where this diverges

| Upstream | Here | Why |
| --- | --- | --- |
| `@picovoice/pvrecorder-node` for capture | An Orphus native capture boundary over pinned miniaudio, under its MIT-0 option | One fewer third-party runtime dependency, and a licence with no attribution obligation on shipped binaries |
| `transcribe-cpp` npm package | A pinned, audited `transcribe.cpp` revision behind a narrow versioned C ABI | The ABI is checked before the backend is accepted — see `native/ABI.md` |
| Backend loaded in-process | A dedicated Bun Worker owning the model, session, microphone, ring buffer, and cancellation token, with a helper-executable fallback over the same JSON-Lines protocol | Transcription is a long CPU-bound native call; on the main thread it would block the UI whose Escape key cancels it |
| Sixty-seven catalog entries | Four that meaningfully differ | A picker nobody can choose from is not a choice |
| Settings written with a plain write | Atomic write at `0600` | A half-written settings file is an unwanted first run |

## Resyncing

1. Fetch upstream and diff against the pinned revision above.
2. Changes to catalog data (new models, corrected checksums) transfer directly —
   update `src/catalog.ts` and the pin here.
3. Changes to capture, the backend, or settings **do not** transfer: those are
   the diverged parts, and a mechanical port would undo the reasons in the table.
4. Update the pin, the subject, and the review date in one commit with the
   changes it justifies.
