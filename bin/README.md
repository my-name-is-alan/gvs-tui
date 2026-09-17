# Windows x64 媒体工具

这些未修改的上游二进制文件由普通 Git 跟踪，clone/pull 后即可使用，无需 Git LFS、解压或另外下载工具。仅适用于 Windows x64。`manifest.json` 记录确切版本、文件长度及 SHA-256；`bun run tools:check` 在禁止网络的条件下验证文件和启动。

- `ffmpeg.exe`：9.0.1 essentials，102,856,192 字节，低于 GitHub 单文件 100 MiB 上限。采用 essentials 而非超过上限的 full 版；项目使用的流复制、解码检查、AES 解密、H.264/HEVC/AAC 功能已验证。不包含用于本机诊断的 ffprobe/ffplay，因为运行时不调用它们。
  - [原始发行包](https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip)
  - [对应 FFmpeg 源码](https://github.com/FFmpeg/FFmpeg/tree/bf1b838f2a)，[Gyan 构建与依赖说明](https://www.gyan.dev/ffmpeg/builds/)
  - GPL v3；许可证和上游完整构建配置见 `licenses/FFmpeg-GPL-3.0.txt`、`licenses/FFmpeg-build-README.txt`。
- `mkvmerge.exe`：58.0.0 静态构建。
  - [原始发行包](https://github.com/Jesseatgao/MKVToolNix-static-builds/releases/download/v58.0.0-mingw-w64-posixv1.8el9/mkvtoolnix-x86_64-win.zip)
  - [对应源代码](https://mkvtoolnix.download/sources/mkvtoolnix-58.0.0.tar.xz)，[静态构建仓库与环境](https://github.com/Jesseatgao/MKVToolNix-static-builds/tree/v58.0.0-mingw-w64-posixv1.8el9)
  - GPL v2；许可证见 `licenses/MKVToolNix-GPL-2.0.txt`。
- `N_m3u8DL-RE.exe`：0.6.0-beta，2026-06-29 发行包，源码提交 `df70f0b3da0c630bd413bf617e758051f6b64757`。
  - [原始发行包](https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.6.0-beta/N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip)
  - [对应源代码](https://github.com/nilaoda/N_m3u8DL-RE/tree/df70f0b3da0c630bd413bf617e758051f6b64757)
  - MIT；许可证见 `licenses/N_m3u8DL-RE-MIT.txt`。
- `packager-win-x64.exe`：Shaka Packager 3.9.3，用于优酷加密轨道处理。
  - [原始文件](https://github.com/shaka-project/shaka-packager/releases/download/v3.9.3/packager-win-x64.exe)
  - [对应源代码及构建说明](https://github.com/shaka-project/shaka-packager/tree/v3.9.3)
  - BSD 3-Clause 及 Chromium 附录；许可证见 `licenses/Shaka-Packager-BSD.txt`。

- `MP4Box.exe`：GPAC `26.03-DEV-rev317-g260872025-master`，静态 MINI 构建，9,315,328 字节，不依赖额外 DLL。用于 DTS 音轨的 MP4 封装及不依赖解码器的样本检查。
  - 从 [StaxRip v2.52.5 原始发行包](https://github.com/staxrip/staxrip/releases/download/v2.52.5/StaxRip-v2.52.5-x64.7z) 的 `Apps/Support/MP4Box/MP4Box.exe` 原样提取，仅包含该可执行文件。归档 SHA-256：`3ced91af31743d6e6611c700c265066bd85cb6954c251bd3dc218209299dcdd0`，已与 GitHub 资产摘要核对。
  - [对应 GPAC 源码](https://github.com/gpac/gpac/tree/260872025)，[构建说明](https://wiki.gpac.io/Build/archives/GPAC-build-MP4Box-only-all-platforms/)。程序报告的构建配置为 `--static-bin --use-zlib=no`，MINI build。
  - LGPL v2.1+；许可证原文见 `licenses/GPAC-LGPL-2.1.txt`。不附带 StaxRip 的凭据、配置、旧 gpac.exe 或其它程序。

FFmpeg、RE、mkvmerge、MP4Box 的下载归档已与 GitHub 发行资产 SHA-256 核对；Shaka 文件已与发行资产摘要核对。更新工具时须同步修改哈希清单，重新运行 `tools:check` 及媒体回归测试。不要提交日志、用户配置、其它平台程序或重复的工具副本。
