# GVS maintained RE

This directory contains the pinned upstream MIT source and the GVS IQ extension.
Source identity is recorded in `gvs-source.json`. The shipping binary is built
from this directory; updates are reviewed and built here rather than replacing
it with an unpatched upstream executable.

```powershell
pwsh scripts/build-managed-re.ps1 -Runtime win-x64 -Install
```

Use .NET SDK 10. The publish output is self-contained and does not require a
user-installed .NET runtime. macOS/Linux use the corresponding runtime ID.

IQ uses `--custom-hls-method IQ_BBTS --custom-hls-key <private-key-file>`.
The client writes a temporary 16-byte key file, removes it on completion or
failure, and keeps the actual content key out of process arguments.
The decoder reads the mdcm IV from each slice, resets counters per NAL, keeps
the encrypted inner CRC until after AES, and preserves TS PCR/continuity.
The initial clear slices are retained unchanged. A source without a current
content key is not decrypted with a sample/default key.

The maintenance workflow publishes six runtime IDs (Windows/macOS/Linux,
x64/arm64) with the license and source identity. Cross-published binaries still
need startup verification on their own platform before release acceptance.

The IQ.2 update reads mdcm mode/vector fields from the bounded SDT service name,
accepts the legacy and a0-first layouts, and reassembles sections split across
TS packets. Provider names, section CRC bytes and other service descriptors
cannot supply missing fields. Unsupported explicit patterns fail closed.

IQ.3 additionally recognizes the complete domestic Web legacy a0/vector/e1/content
layout from the reference implementation. Explicit unknown modes, incomplete
vectors and conflicting content tags are rejected.

IQ.6 adds `CHACHA20_V3_SDD` for the confirmed Tencent HEVC profile. The custom
key is 76 bytes: outer V3 key (32), inner V2 key (32), inner nonce (12).
The custom IV is the 12-byte outer nonce. The client builds this material from
the gateway response; users do not need to supply a key. The outer-only V3
method remains separate, so an older client rejects the new method explicitly.

After outer decryption, the downloader reassembles video PES and Annex B NALs,
removes ciphertext emulation prevention, and restores the confirmed sparse
pattern. The restored bytes already contain the original HEVC emulation
prevention and must not be escaped again. PES timestamps, audio packets and
PCR fields are retained. The first video packet marks a discontinuity because
video packet counts can change; continuity is rebuilt within each segment.
Separate audio receives outer decryption only. Unsupported containers fail.
The confirmed private `c0/tvf2` PMT video declaration becomes standard HEVC
`24` with a new MPEG-2 section CRC, including sections split across TS packets.
This is required for the final MKV muxer to retain the video track.
