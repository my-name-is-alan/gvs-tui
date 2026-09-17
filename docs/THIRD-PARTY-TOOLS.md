# 源码运行所需工具

Windows x64 首次启动自动下载媒体工具到项目根目录 `bin/`，也可运行 `bun run tools:prepare` 提前准备。工具、Bun 和依赖不提交到 Git，不再生成便携包。工具按原项目许可证提供，来源如下。

- FFmpeg / Gyan Windows builds: https://github.com/GyanD/codexffmpeg ，源代码 https://ffmpeg.org/download.html ，许可证 https://ffmpeg.org/legal.html （本机 full build 为 GPL 构建）。
- N_m3u8DL-RE: https://github.com/nilaoda/N_m3u8DL-RE ，MIT https://github.com/nilaoda/N_m3u8DL-RE/blob/main/LICENSE 。
- mkvmerge / MKVToolNix: https://mkvtoolnix.download/ ，GPL v2；当前自动准备来源 https://github.com/Jesseatgao/MKVToolNix-static-builds 。
- Shaka Packager: https://github.com/shaka-project/shaka-packager ，Apache 2.0 https://github.com/shaka-project/shaka-packager/blob/main/LICENSE 。

`bun run build` 只编译源码；`bun run start` 自动编译后启动，使用项目 `node_modules/` 和 `bin/`。OpenTUI 及原生库由 `bun install --frozen-lockfile` 按锁文件安装，不需要手工复制 DLL。

- Bun: https://github.com/oven-sh/bun ，MIT；随附第三方组件许可证见 https://github.com/oven-sh/bun/tree/main/packages/bun-licenses 。
- OpenTUI: https://github.com/anomalyco/opentui ，MIT。依赖版本记录在 `bun.lock`，许可证位于对应 npm 包内。
