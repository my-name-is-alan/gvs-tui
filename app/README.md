# GVS 桌面端（Windows / macOS）

Electron + Vue 3 的图形界面，替代在旧版 Win10 控制台里缺字、错位的 TUI。
业务逻辑**直接复用** `../src/lib`（网关客户端、隧道、画质探测、下载/解密/封装、命名、NFO），
和 TUI 读写同一份配置 `%APPDATA%\gvs\tui.json`（macOS：`~/.config/gvs/tui.json`），
两边切换不用重新填网关和登录。源站 Cookie / yk_sign 由网关按 API key 加密托管，配置文件里不再保存凭证。下载目录是其中的 `outDir`：设置页「保存到」，第一次连接时也能改。
没配过时 Windows 默认用空间最大的非系统盘 `盘符:\GVS`，不再跟着程序目录落到 C 盘。

优酷、腾讯、IQ 海外版的电影/剧集类型先采用平台元数据，并保留搜索卡片的类型作为详情兜底。
TMDB 搜索同时显示电影和剧集；准确匹配的片名与年份可以纠正平台缺失的类型。
片名末尾的「第2季」「第二季」「Season 2」等标签会分开处理：按主片名搜索 TMDB，季号用于文件名和季目录；第二季的年份不会被拿来限制整部剧的首播年份。
画质页「输出 → 内容类型」也可手动切换电影/剧集，影响体积文案、文件名预览及实际任务的季集编号；
选定 TMDB 条目时采用该条目的类型，电影不添加 `Season 01` / `S01E01`。
节目文件夹使用 `片名 (年份) {tmdb-ID}`，例如 `妾本草芥 (2026) {tmdb-335218}`；剧集下再分 `Season 01` 等季目录。年份或 ID 缺失时省略对应部分，文件名仍使用点号分隔；已有目录不会自动改名。

腾讯所选画质的格式 ID、编码版本、字幕类型、分辨率、帧率和动态范围会保存在下载任务中，暂停、继续和重试沿用同一选择。
取链传入 `defn` / `caption` 和具体 `format_id`，编码版本使用独立的 `rendition_persona` 参数。
网关明确返回不同版本，或无法确认所选编码版本的独立地址时，停止下载并提示重新取流。
`encode=all` 只用于画质探测，混合列表中的条目不能证明默认播放地址属于该条目。
下载后校验实际视频规格和视频轨时长，封装后再次检查视频及每条音轨的完整性，防止试看视频混入完整音轨后被记为完成。此版本需要网关 3.9.36。
HLS 下载速度按分片文件（含正在写入的临时分片）的近期字节增量估算，不把已缓存的分片当作本次下载速度。

新完成的腾讯任务会显示本机读取的分辨率、编码、帧率、码率等视频规格，以及封装后的文件大小；下载列表不显示格式 ID 或身份确认提示。`actualVersion` 写入 `jobs.json`，同时集中归档到用户数据目录的 `actual-versions.jsonl`；视频目录不生成 `.gvs.json`。实际身份只从下载地址对应的证据确认，证据不足则在记录中保留未知状态。视频规格由本机 `ffprobe` 读取，缺少工具不影响成功下载，仍可显示已记录的文件大小。记录使用文件大小与 SHA-256 抽样指纹关联文件，移动或重命名后仍可核验。所选档位与实际版本分开保存，完整性验收通过后才保存完成记录。旧历史不能自动补出当时的实际版本；`maxplus` / `suhd` 也不因此成为 HQ。详见 [实际版本记录说明](../docs/ACTUAL-VERSION-RECORDS.md)。

IQ 字幕优先正常简体、繁体，缺少一种时用内置 OpenCC 补齐；两种正常中文字幕都没有时才保留 AI 简繁并按需补齐，转换得到的 AI 字幕继续标注 AI。其他语言只保留正常字幕。封装顺序为简体、繁体、其余语言，简体默认播放；转换保持时间轴和样式，失败时保留原字幕并提示。

## 开发

```bash
bun install
bun run dev          # 热更新
bun run typecheck    # 主进程 + 界面类型检查
node --test src/main/iq-auth-transport.node-check.ts  # IQ 显式代理检查，使用桌面端的 Node 运行时
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
src/main/env.ts        网络环境：隧道和 IQ 海外版接口使用配置或系统代理，默认上游直连
src/main/desktop-network.ts  网关 / TMDB 的独立代理会话，不修改默认网络会话
src/main/shims/        构建时替换 TUI 里依赖 Bun 的 proxy.ts、依赖源码布局的 tool-paths.ts
src/shared/api.ts      主进程 ↔ 界面契约
src/renderer/          界面（设计稿：GVS 桌面端设计稿，米白/墨黑/橙色硬阴影）
```

桌面版可在「设置 → 网关 → 代理地址」或首次连接页填写 HTTP/HTTPS 代理，如 `http://127.0.0.1:7890`；
端口按自己的代理软件填写，留空使用系统代理与 PAC。地址以 `desktopProxy` 保存在本机配置，重启后继续使用；
与终端版的 `gatewayProxy` / `tmdbProxy` 独立。保存后网关重连；连接失败恢复先前配置，显式代理失败不回退直连。
网关 HTTP、隧道 WebSocket、TMDB、IQ 海外版登录和取流使用这个地址，代理节点与分流仍由代理软件决定。
网关与 TMDB 使用独立的 Chromium 网络会话，本机网关始终直连；不会修改默认会话、媒体下载与图片的路由。
优酷、腾讯和爱奇艺国内版上游保留直连；IQ 海外版的 `iq.com`、`intl-passport.iqiyi.com`、
`inter.iqiyi.com`、`video.iqiyi.com` 接口通过代理。Clash 规则模式下需给这些域名配置相应代理组，无需开启 TUN。
`~/.config/gvs/desktop-run.log` 中的 `iq_auth_transport` / `iq_source_transport` 记录域名、配置或系统代理决策与 HTTP 状态，
不记录账号、Cookie、请求路径或请求正文；节点与实际分流结果以 Clash 连接日志为准。

IQ 的 Web / TV 会话由网关保存和恢复，桌面端不保存账号密码，也不把登录成功的界面状态当作有效会话。
启动时等隧道连接后查询一次会话状态，打开平台账号页时也自动查询；并发状态查询合并，查询失败不会自动登录。
侧栏分别显示“待检查”“已登录”“Web 已登录”“未登录”或“需验证”；环境风险按网关返回的状态提示，由用户在官方页面完成校验。

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
