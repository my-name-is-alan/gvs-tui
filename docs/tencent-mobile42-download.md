# Tencent mobile42 local download consumer

This is an explicit App profile, separate from the TV and legacy ChaCha20 downloader. It consumes the gateway's `protocol=mobile42` response and `tencent-mobile42-9.04.70.32414-v3-sdd2-hevc-v1` media profile. It does not make encrypted CDN URLs directly playable in an external player.

The operator configures `tencentMode: "app"` and `tencentMobile42: { accountSource: "app_sync" | "gateway", context: ... }` in the existing private client configuration. `context` uses the gateway's PascalCase `Account`, `Device`, `Scene`, `Signing`, `Assessment` and `Source` schema. `Account.Cookie` must be absent. All device/signing/source fields must come from the authorized matching context; the client supplies no handset defaults and does not synthesize playback or advertising state. The shared request code copies the current job VID and selected definition into `Scene`. A pre-VID asset cannot be rebound to another VID. The gateway remains responsible for validating current account, snapshot generation, freshness, signing and entitlement. Ordinary App configuration without this opt-in retains its existing route; TV/IMAX plus this profile is rejected.

`Signing` can contain sensitive material. Keep the configuration private. The renderer settings view, job records and diagnostics do not contain this object. Successful and failed invoke logs replace the `mobile` input with `[private]`.

Run `bun run tools:mobile42` to build the shared Go CLI. The default source checkout is `../get_video_streaming`; set `GVS_GATEWAY_SOURCE` or pass `--source=/absolute/path` when different. `scripts/mobile42-decoder-sources.json` pins the reviewed CLI, media package and Go module files. Builds fail when those files change, and run with Go proxy, sum database and toolchain downloading disabled. The build writes the executable plus a SHA256 sidecar; the consumer checks both before downloading. Development uses `bin/`; Electron uses the installed `resources/bin`. Windows x64 and macOS arm64/x64 packaging includes this executable and its checksum. Installed clients require no Go runtime or SDK wrapping profile.

Each attempt binds one immutable response/manifest/context. A private temporary response is wrapped as `{code:0,data:...}` for the CLI; secrets are never passed in argv. POSIX scratch directories are 0700 and files are created 0600 with exclusive creation. On Windows, the new scratch directory removes inherited ACL entries and grants the current user SID access before the response is written; failure stops the attempt. Windows runtime ACL behavior still requires platform validation.

The consumer accepts a finite TS media playlist, one known immutable custom key and explicit `METHOD=NONE` scopes. It rejects master, range, partial, unknown-key and rotating-key declarations before fetching. Complete segments are downloaded locally with a 32 MiB input bound, limited concurrency and a bounded ordered buffer. The Go CLI independently validates the full manifest and selects the active key using `--segment-index`; cipher origin is zero within each segment, never CDN `brs` or file offset. NONE segments are TS-validated and copied unchanged. This consumer also conservatively limits each decoded output to 32 MiB, so an input near the limit whose decoded TS expands beyond it is rejected. Helper processes have a timeout, fixed diagnostics and cancellation that waits for exit. All private response/source/helper files and incomplete combined output are removed on failure or cancellation. There is no automatic identity rotation or context refresh during an attempt.

After ordered assembly, the shared Tencent job retains its existing coverage/specification checks and mux/final-file publication. Progress reports real transferred bytes to the UI. This branch does not bind TV reports or invent watch time, ad viewing or completion events. External `openPath` is not a playback event source.

Offline checks:

```sh
bun test src/lib/tencent-mobile42.test.ts src/lib/tencent-mobile42-client.test.ts src/lib/tencent-qr.test.ts src/lib/desktop-tool-paths.test.ts
GVS_MEDIA_TESTS=1 bun test src/lib/tencent-mobile42-job.test.ts
GVS_MOBILE42_RETAINED_GATEWAY=/absolute/local/gateway bun test src/lib/tencent-mobile42-retained.test.ts
bun run build
```

The default tests use synthetic data and fake HTTP. The shared `runTask` integration uses explicit test-only helper/mux façades and real local FFmpeg; it verifies the route and file/metadata lifecycle, not the mobile cipher or packaged mkvmerge. The opt-in retained test reads operator-held EP36 files, verifies original manifest indexes 0/10/62 through the actual shared Go helper, then checks ordered processing of a derived three-entry playlist with local fake fetch. It makes no upstream request, does not refresh capture timestamps and does not establish current authorization, continuous playback or full-episode completion. A packaged desktop download with the real muxer and actual player feedback remains a separate acceptance step.
