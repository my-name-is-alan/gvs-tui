# GVS 桌面端（Windows / macOS）

Electron + Vue 3 的图形界面，替代在旧版 Win10 控制台里缺字、错位的 TUI。
业务逻辑**直接复用** `../src/lib`（网关客户端、隧道、画质探测、下载/解密/封装、命名、NFO），
和 TUI 读写同一份配置 `%APPDATA%\gvs\tui.json`（macOS：`~/.config/gvs/tui.json`），
两边切换不用重新填网关和登录。下载目录是其中的 `outDir`：设置页「保存到」，第一次连接时也能改。
没配过时 Windows 默认用空间最大的非系统盘 `盘符:\GVS`，不再跟着程序目录落到 C 盘。

优酷、腾讯的电影/剧集类型先采用平台元数据，并保留搜索卡片的类型作为详情兜底。
TMDB 搜索同时显示电影和剧集；准确匹配的片名与年份可以纠正平台缺失的类型。
片名末尾的「第2季」「第二季」「Season 2」等标签会分开处理：按主片名搜索 TMDB，季号用于文件名和季目录；第二季的年份不会被拿来限制整部剧的首播年份。
画质页「输出 → 内容类型」也可手动切换电影/剧集，影响体积文案、文件名预览及实际任务的季集编号；
选定 TMDB 条目时采用该条目的类型，电影不添加 `Season 01` / `S01E01`。
节目文件夹使用 `片名 (年份) {tmdb-ID}`，例如 `妾本草芥 (2026) {tmdb-335218}`；剧集下再分 `Season 01` 等季目录。年份或 ID 缺失时省略对应部分，文件名仍使用点号分隔；已有目录不会自动改名。

腾讯所选画质的格式 ID、编码版本和字幕类型会保存在下载任务中，暂停、继续和重试沿用同一选择。
取链使用兼容的 `defn` / `caption` 参数；网关没有所选条目的独立地址时继续使用返回的默认流，不因编码版本无法核验而停止。
`encode=all` 只用于画质探测，混合列表中的条目不能证明默认播放地址属于该条目。
实际编码版本和文件大小可能与探测列表不同；旧任务未保存版本信息时仍可继续和重试。
HLS 下载速度按分片文件（含正在写入的临时分片）的近期字节增量估算，不把已缓存的分片当作本次下载速度。

新完成的腾讯任务会显示本机读取的分辨率、编码、帧率、码率等视频规格，以及封装后的文件大小；下载列表不显示格式 ID 或身份确认提示。`actualVersion` 写入 `jobs.json`，同时集中归档到用户数据目录的 `actual-versions.jsonl`；视频目录不生成 `.gvs.json`。实际身份只从下载地址对应的证据确认，证据不足则在记录中保留未知状态。视频规格由本机 `ffprobe` 读取，缺少工具不影响成功下载，仍可显示已记录的文件大小。记录使用文件大小与 SHA-256 抽样指纹关联文件，移动或重命名后仍可核验。所选档位与实际版本分开保存，默认流仍按原方式下载。旧历史不能自动补出当时的实际版本；`maxplus` / `suhd` 也不因此成为 HQ。详见 [实际版本记录说明](../docs/ACTUAL-VERSION-RECORDS.md)。

## 开发

```bash
bun install
bun run dev          # 热更新
bun run typecheck    # 主进程 + 界面类型检查
```

Electron 二进制下载慢时：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，
再执行 `node node_modules/electron/install.js`。

## 打包

```bash
bun run dist:win     # release/GVS-Setup-<版本>-x64.exe（NSIS，可选安装目录，自带媒体工具）
bun run dist:mac     # 需在 Mac 上执行；release/GVS-<版本>-arm64.dmg / -x64.dmg
```

- Windows 包把 `../bin` 里的 ffmpeg / N_m3u8DL-RE / mkvmerge / MP4Box / shaka-packager 放进 `resources/bin`。
- macOS 包不带工具：`brew install ffmpeg gpac mkvtoolnix`。应用会把 Homebrew 路径补进 PATH，
  包装脚本写在用户数据目录的 `bin/`，不改动 .app 本身。
- 目前没有代码签名；macOS 首次打开需右键 → 打开。

## 结构

```text
src/main/index.ts      窗口、IPC（gvs:call 按方法名分发）
src/main/core.ts       业务编排：连接/隧道、浏览、搜索、详情、探测、入队、账号登录
src/main/posters.ts    gvs-img:// 海报协议：带 Referer 直连 + 磁盘缓存，HEIC 用 ffmpeg 转 JPG
src/main/env.ts        网络环境：网关走系统代理，CDN/上游直连；隧道 WebSocket 挂代理
src/main/shims/        构建时替换 TUI 里依赖 Bun 的 proxy.ts、依赖源码布局的 tool-paths.ts
src/shared/api.ts      主进程 ↔ 界面契约
src/renderer/          界面（设计稿：GVS 桌面端设计稿，米白/墨黑/橙色硬阴影）
```

网络约定与 TUI 相同：网关与 TMDB 请求走 Chromium 网络栈（跟随系统代理，适配网关屏蔽 CN 的部署）；
优酷/腾讯上游经隧道、CDN 分片都从本机直连。

## 下载任务

- 任务列表存在用户数据目录的 `jobs.json`，重启后还在；上次没下完的变成「已中断」，点继续接着下。
  只存任务本身和入队时钉住的目录/并发等设置，不存 Key、Cookie 和登录态。
- 可以暂停、继续、删除（可选同时删除文件）。直链分片下载（红果、黄果直链、腾讯、抖音）从断点续传；
  优酷与黄果 HLS 走 N_m3u8DL-RE，暂停后继续会重新下载这一集。
- 完成的腾讯任务保留实际版本确认结果；清理任务列表后集中档案仍保留。选择“同时删除文件”时删除成品及旧版遗留的 `.gvs.json`。
- 中间文件放在「临时目录」：默认是下载目录下的 `.gvs-tmp`（同盘，完成后直接改名），
  设置里可以改到别的盘；每个任务一个子目录，完成后自动删除，失败/暂停的保留给重试和续传。
  设置 → 下载 → 缓存 可以清掉海报缓存和没有任务在用的临时残留。

## 已知限制（v0.1）

- 抖音只支持在设置里填 Cookie 后搜索，暂未接入抖音下载流程。
- 只有浅色主题。
