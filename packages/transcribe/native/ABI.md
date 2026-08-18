# The native ABI

The TypeScript in this package never calls miniaudio or transcribe.cpp. It calls
the handful of C functions below, and it refuses to use a library that does not
report the ABI version and build hash this release expects.

That check is the point. A shared library that happens to export the right
symbol names is not the artifact this release was tested against, and loading it
would turn a build mismatch into a crash inside native code. Both halves are
verified before the backend is handed a single request:
`orphus_transcribe_abi_version()` must equal
`EXPECTED_NATIVE_ABI_VERSION` in `src/protocol.ts`, and
`orphus_transcribe_build_hash()` must match the hash recorded for the shipped
artifact.

## Version 1

```c
/* Identity. Called first, before anything else. */
int32_t     orphus_transcribe_abi_version(void);
const char *orphus_transcribe_build_hash(void);   /* 64 hex chars, NUL-terminated, static */
const char *orphus_transcribe_description(void);  /* diagnostics only */

/* Lifecycle. One session per process. */
typedef struct orphus_transcribe_session orphus_transcribe_session;

orphus_transcribe_session *orphus_transcribe_open(const char *model_path,
                                                  const char *language,
                                                  int32_t     sample_rate,
                                                  int32_t    *out_error);
void                       orphus_transcribe_close(orphus_transcribe_session *session);

/* Capture. Devices are enumerated as a NUL-separated, double-NUL-terminated
   list so the caller needs no allocator on this side of the boundary. */
const char *orphus_transcribe_list_devices(orphus_transcribe_session *session);
int32_t     orphus_transcribe_start(orphus_transcribe_session *session, const char *device /* or NULL */);
float       orphus_transcribe_level(orphus_transcribe_session *session);

/* Transcription. `stop` drains the ring buffer and runs the model; it blocks,
   which is why it runs on a Worker and never on the main thread. The returned
   string is owned by the session and is valid until the next call. */
const char *orphus_transcribe_stop(orphus_transcribe_session *session, int32_t *out_error);

/* Cancellation. Safe to call from another thread while `stop` is running: it
   sets the session's cancellation token, and `stop` returns
   ORPHUS_TRANSCRIBE_CANCELLED. This is what makes Escape work during the
   expensive part rather than only before it. */
void orphus_transcribe_cancel(orphus_transcribe_session *session);

/* Error codes, mapped onto the protocol's ErrorCode by the worker. */
#define ORPHUS_TRANSCRIBE_OK                 0
#define ORPHUS_TRANSCRIBE_MODEL_LOAD_FAILED  1
#define ORPHUS_TRANSCRIBE_NO_CAPTURE_DEVICE  2
#define ORPHUS_TRANSCRIBE_CAPTURE_FAILED     3
#define ORPHUS_TRANSCRIBE_FAILED             4
#define ORPHUS_TRANSCRIBE_CANCELLED          5
#define ORPHUS_TRANSCRIBE_NOT_INITIALIZED    6
```

## The helper executable

The fallback runs `orphus-transcribe-helper`, which links the same library and
speaks the JSON-Lines protocol in `src/protocol.ts` on stdin/stdout. It exists
for runtimes without Bun FFI and for hosts where the library will not load in
process. Because it speaks the same protocol, falling back changes the transport
and nothing else.

## Layout

Artifacts live under `native/<triple>/`, where the triple is what
`nativeTriple()` in `src/channels.ts` computes:

```
native/macos-arm64/        macos-x64/
native/linux-arm64-gnu/    linux-x64-gnu/
native/linux-arm64-musl/   linux-x64-musl/
native/windows-arm64/      windows-x64/
```

glibc and musl are separate triples because they are not interchangeable: a musl
host loading a glibc build fails at `dlopen` with a message nobody can act on.

Each directory holds `orphus_transcribe.{dylib,so,dll}` and
`orphus-transcribe-helper[.exe]`.

## Status

**The native artifacts are not built in this repository yet.** The boundary
above is defined, both channels that consume it are implemented, and the whole
TypeScript side is tested against a scripted backend — but until the eight
targets are built, `openWorkerChannel` and `openHelperChannel` both report that
the artifact is missing and dictation is unavailable. That is a deliberate
fail-closed: an absent native library must look like an absent feature, not like
a crash.

Before dictation is enabled in a release, every one of the eight archives must
pass native startup, recording-device enumeration, cancellation, and
helper-fallback smoke tests. Metal on macOS and Vulkan on supported glibc builds
may accelerate transcription; neither is required, and a build without them must
still pass.
