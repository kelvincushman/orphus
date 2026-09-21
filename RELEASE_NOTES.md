# Orphus 2.3.1

One fix, for a bug that has been in every Linux release since the archives
began: the `linux-x64` build could not start on any CPU older than 2013.

## The Linux x64 archive runs on pre-AVX2 CPUs again

`orphus --version` from the published archive died with `Illegal instruction
(core dumped)` — exit 132, no message, no stack — on anything older than
Haswell. Bun's standard x64 runtime is compiled for AVX2, so the process took
SIGILL inside the runtime before a line of user code ran.

It was not a regression in 2.3.0. v2.1.2 fails identically on the same machine,
and so does every archive before it.

The reason it went unnoticed for so long is the part worth repeating. The
release workflow does check that the archive works:

```
test "$(release/orphus/orphus --version)" = "$VERSION"
```

That check is real, and it passed every time — on a GitHub runner, which has
AVX2. The smoke test and the hardware it could not represent were the same
blind spot, so a working artifact and an unusable one looked identical from CI.

The x64 Linux targets now compile against Bun's `-baseline` runtime, which drops
the AVX2 requirement. Modern CPUs give up some JS throughput for it. That is the
cheaper side of the trade for a program that spends its time waiting on model
responses rather than on its own interpreter, and it keeps one archive per
platform rather than making the installer read `/proc/cpuinfo` to choose between
two. macOS and arm64 are untouched — the split does not exist there.

If `orphus` has ever exited 132 on your machine with no output, this is why, and
this release fixes it.

## Install

Download the archive for your platform and `SHA256SUMS` from this release,
verify, extract, and run. macOS and Linux users can continue using
`orphus update` or the existing shell installer.
