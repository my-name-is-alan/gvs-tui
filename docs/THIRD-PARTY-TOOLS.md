# 源码运行所需工具

Windows x64 的四个媒体工具作为普通二进制文件提交在项目根目录 `bin/`，随 `git clone/pull` 一起取得，不使用 LFS，也不生成便携包。版本、大小和 SHA-256 位于 `bin/manifest.json`；具体发行文件及源码来源见 [bin/README.md](../bin/README.md)，许可证原文位于 `bin/licenses/`。Bun 和 npm 依赖仍需安装。

- FFmpeg 9.0.1 essentials / Gyan Windows builds: https://github.com/GyanD/codexffmpeg ，源码提交 https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a ，GPL v3；原构建说明已保留在 `bin/licenses/FFmpeg-build-README.txt`。
- N_m3u8DL-RE: https://github.com/nilaoda/N_m3u8DL-RE ，MIT https://github.com/nilaoda/N_m3u8DL-RE/blob/main/LICENSE 。
- mkvmerge / MKVToolNix: https://mkvtoolnix.download/ ，GPL v2；当前自动准备来源 https://github.com/Jesseatgao/MKVToolNix-static-builds 。
- Shaka Packager 3.9.3: https://github.com/shaka-project/shaka-packager ，BSD 3-Clause 及 Chromium 许可附录，原文 https://github.com/shaka-project/shaka-packager/blob/v3.9.3/LICENSE 。

`bun run build` 只编译源码；`bun run start` 自动编译后启动，使用项目 `node_modules/` 和 `bin/`。OpenTUI 及原生库由 `bun install --frozen-lockfile` 按锁文件安装，不需要手工复制 DLL。

- Bun: https://github.com/oven-sh/bun ，MIT；随附第三方组件许可证见 https://github.com/oven-sh/bun/tree/main/packages/bun-licenses 。
- OpenTUI: https://github.com/anomalyco/opentui ，MIT。依赖版本记录在 `bun.lock`，许可证位于对应 npm 包内。
