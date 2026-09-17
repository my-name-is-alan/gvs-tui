# 优酷下载与播放回归验证

本次改动修复 CDN 链接失效后的换链续传，以及分轨合并时丢失原始相对起点的问题。不能据此推断所有播放器上的口型同步已经验证通过。

## 启动

```powershell
bun install --frozen-lockfile
bun run tools:prepare
bun run build
bun run start
```

复制发行目录时应包含整个 `dist`（含 `bin`）。登录、网关配置和下载文件不包含在 Git 中，测试者使用自己的配置。

## 下载验证

- 用相同集数、视频档位和音轨测试，记录线程数。线程数仍传给 RE，本地集成测试确认 4 个分片请求能同时到达服务器。
- 403/410 后应显示重新取 CDN 链接，并从失败分片继续；已下载进度不能回到起点。单个分片最多换链 10 次。
- 成品旁的 `.timing.json` 记录合并前后的实际呈现起点；`.transport.json` 记录请求状态、并发峰值及换链耗时。起点检查不等同于口型检查。
- 失败时保留 `.re-*` 和 `.download-error.log`。`GVS_KEEP_INTERMEDIATES=1` 可保留成功任务的独立音视频用于复查。

## 播放验证

已在当前机器复现：E13 开头约 7.983 秒后，4K60 Dolby Vision 在 PotPlayer 中画面落后于声音；音轨原样复制、未加延迟的低负载 H.264 黑白对照片段经用户确认同步正常。原视频 MP4 与 MKV 前 28 秒的 1,680 个解码帧及呈现时间一致。此结果倾向于播放器解码/渲染路径问题，但仍需在其它机器验证 4K 原片，不能用低负载样本代替整集验证。

在测试机器上记录播放器版本、GPU、解码器、渲染器、实际播放帧率及丢帧数；音频延迟和播放速度使用默认值。检查 0–15 秒（尤其 7.983 秒边界）、中段、结尾，以及拖动进度后的同步情况。分别测试同一内容的 MKV 与 MP4，区分容器、解码性能和内容偏移。不要统一添加固定 7.983 秒延迟。

## 本地回归命令

```powershell
bun test
bun run scripts/check-bundled-download.ts
bun run scripts/check-mux-sync.ts
bun run scripts/check-audio-repair.ts
```

离线集成覆盖三次失效 URL 换链、慢取链恢复、并发下载、CENC 解密、逐包内容/PTS 比对、正负相对起点、多音轨和截断拒绝。在线测试工具 `scripts/check-youku-transport.ts` 需要测试者自己的网关登录；临时原始日志可能包含短期签名链接，不要公开。
