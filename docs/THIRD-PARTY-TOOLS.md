# 随包工具

完整发行目录包含 `main.js` 和 `bin/`，请整体保留。运行时无需设置 ffmpeg 或另行安装下载器。
`manifest.json` 记录本次打包的文件 SHA-256。工具按原项目许可证提供；发布方应同时提供对应构建的许可证和源代码获取方式。

- FFmpeg / Gyan Windows builds: https://github.com/GyanD/codexffmpeg ，源代码 https://ffmpeg.org/download.html ，许可证 https://ffmpeg.org/legal.html （本机 full build 为 GPL 构建）。
- N_m3u8DL-RE: https://github.com/nilaoda/N_m3u8DL-RE ，MIT https://github.com/nilaoda/N_m3u8DL-RE/blob/main/LICENSE 。
- mkvmerge / MKVToolNix: https://mkvtoolnix.download/ ，GPL v2；当前自动准备来源 https://github.com/Jesseatgao/MKVToolNix-static-builds 。
- Shaka Packager: https://github.com/shaka-project/shaka-packager ，Apache 2.0 https://github.com/shaka-project/shaka-packager/blob/main/LICENSE 。

源码开发可运行 `bun run tools:prepare` 自动补齐工具，`bun run build` 会将工具实际复制到 `dist/bin`；分发时不能只发送 `main.js`。现有 Windows x64 包内包含全部四个工具。
