# 随包工具

完整发行目录包含 `main.js` 和 `bin/`，请整体保留。运行时无需设置 ffmpeg 或另行安装下载器。
`manifest.json` 记录本次打包的文件 SHA-256。工具按原项目许可证提供；发布方应同时提供对应构建的许可证和源代码获取方式。

- FFmpeg / Gyan Windows builds: https://github.com/GyanD/codexffmpeg ，源代码 https://ffmpeg.org/download.html ，许可证 https://ffmpeg.org/legal.html （本机 full build 为 GPL 构建）。
- N_m3u8DL-RE: https://github.com/nilaoda/N_m3u8DL-RE ，MIT https://github.com/nilaoda/N_m3u8DL-RE/blob/main/LICENSE 。
- mkvmerge / MKVToolNix: https://mkvtoolnix.download/ ，GPL v2；当前自动准备来源 https://github.com/Jesseatgao/MKVToolNix-static-builds 。
- Shaka Packager: https://github.com/shaka-project/shaka-packager ，Apache 2.0 https://github.com/shaka-project/shaka-packager/blob/main/LICENSE 。

源码开发可运行 `bun run tools:prepare` 自动补齐工具，`bun run build` 会将工具实际复制到 `dist/bin`；分发时不能只发送 `main.js`。现有 Windows x64 包内包含全部四个工具。

`bun run build` 还包含 `dist/node_modules` 中的 OpenTUI 及必要依赖（含原生 DLL/WASM）；普通 dist 需已安装 Bun。`bun run package:windows` 额外打包当前构建使用的 Bun 到 `runtime/bun.exe`，并生成 `start.cmd`，让完整包不依赖用户机器上已安装的 JS 运行时。

- Bun: https://github.com/oven-sh/bun ，MIT；随附第三方组件许可证见 https://github.com/oven-sh/bun/tree/main/packages/bun-licenses 。
- OpenTUI: https://github.com/anomalyco/opentui ，MIT。包内保留 npm 运行依赖自带的许可证文件，版本清单在 `runtime-manifest.json`。
