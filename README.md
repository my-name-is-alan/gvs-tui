# GVS TUI

本机终端下载器。Bun 单进程：Vue TermUI 画面 + TypeScript 运行时。只通过 HTTP 调远端网关（地址和 API Key 由用户填写）。

服务端不代下媒体。优酷/腾讯上游请求经 `/v1/tunnel` 从本机 IP 出网；CDN 由本机直拉。

**对接契约：** [docs/GATEWAY.md](docs/GATEWAY.md)

## 运行

需要 Bun ≥ 1.3。Windows x64 构建内置 ffmpeg、N_m3u8DL-RE、mkvmerge 和 Shaka Packager，无需用户下载或设置工具路径。不需要 Go。工具优先从程序旁的 `bin/` 读取，不依赖启动目录或系统 PATH。

```powershell
bun install
bun run dev
```

第一次填网关 Base URL + 管理台发的 API Key。配置在用户目录 `gvs/tui.json`。

```powershell
bun run build
bun run start
```

`bun run build` 会实际将工具复制到 `dist/bin/`，分发时保留整个 `dist/`。源码首次启动缺少工具时会自动准备，也可提前执行 `bun run tools:prepare`。[第三方工具说明](docs/THIRD-PARTY-TOOLS.md)。

`Ctrl+C` 退出。

## 结构

```text
docs/GATEWAY.md       网关 HTTP / 隧道 / 画面协议
scripts/preview.ts    离屏渲染每个画面，不需要网关
src/Root.vue          终端画面（外壳 + 各场景）
src/components/       列表行 / 剧集宫格 / 快捷键 / 转圈
src/lib/theme.ts      配色与语义色（唯一改颜色的地方）
src/lib/rows.ts       按列对齐的单行渲染
src/lib/text.ts       按显示宽度截断（中文占 2 格）
src/lib/grid.ts       剧集宫格排版
src/lib/demo.ts       预览用的假数据
src/runtime.ts        状态机、网关、隧道、下载、扫码
src/lib/youku-session.ts  优酷登录态与会员探测（cred / account / refresh）
src/lib/              HTTP 客户端 / 画质探测 / ffmpeg / 命名
```

Vue 不直接 `fetch` 网关；通过 `Runtime` 同进程调用。

## 画面

固定外壳：顶栏（品牌 / 面包屑 / 网关 / 隧道）、正文区、状态行、快捷键栏。状态行永远占位，所以提示出现或消失时正文不会跳动；列表按显示宽度对齐，选中行整行高亮。

想不看网关直接改画面，用离屏渲染：

```powershell
bun run preview              # 每个画面渲染到 preview/*.txt 并打印
bun run preview jobs detail  # 只渲染指定画面
$env:PREVIEW_SIZE='80x24'; bun run preview
```

也可以让 TUI 直接跑假数据交互（无网关、无 Key、不联网）：

```powershell
$env:GVS_PREVIEW='jobs'; bun run dev     # 顶栏会显示 PREVIEW
```

## 起不来的时候

dev server 编译缓存坏掉时，画面会停住或报
`failed to launch /src/main.ts` + `null is not an object (evaluating 'compiler.parse')`，
看起来很像"隧道断了"，其实是 UI 根本没跑起来。清缓存即可：

```powershell
bun run dev:clean      # 先删 node_modules/.vite，再用 bun --bun vite --force 起
# 还不行就手动删：
Remove-Item -Recurse -Force node_modules/.vite, node_modules/.vite-temp
```

判断方法：`Get-NetTCPConnection -OwningProcess <bun pid> | ? RemotePort -eq 443`，
没有连接就说明应用没起来（正常时至少有 1 条到网关）。

## 优酷登录态（不用每次重新扫码）

网关按 Yk-Sign 维度存了优酷会话，并支持**自己续期**（stoken/ptoken），TUI 现在会用它：

- 启动时自检：`cred info` 看签名 → 距上次续期超过 20 分钟就自动续期（不需要扫码）→ 查账号
- 首页第一行和设置页「优酷登录」显示同一个摘要：昵称 · uid · 已登录(qr) · 会员状态
- 请求报 `needs re-login` 时**先自动续期**，续成功就用原签名重试，用户不用重新扫码；
  只有网关明确说 `needs_relogin`，或 `cred info` 认不出本机签名时才提示去扫码
- 续期失败会**再试一次不带签名的请求**（网关侧会话兜底），而且只覆盖这一次的请求头，
  绝不改动 `tui.json` 里的签名
- 设置 → 「优酷登录」回车 = 手动续期 + 重查会员

**判断规则（踩过坑，别再用 SESSION_EXPIRED 下结论）：**

| 看到什么 | 含义 |
| --- | --- |
| `cred info` 报 `yk_sign not found or revoked` | 本机签名不在网关凭证库里 → 只能重新扫码 |
| `play` 报 `invalid Yk-Sign` | 同上；`account` 还能答，那是网关自己的全局会话 |
| `account/profile` 里会员接口报 `FAIL_SYS_SESSION_EXPIRED` | 只是**会员接口要网页 Cookie**，扫码登录必然如此，**不是掉登录** |
| `session.logged_in=true` + `risk.level=none` | App 会话正常，能搜能放 |
| `quality_gate.is_vip=true / can_play=true` | 会员权益真的生效（唯一的功能性判据） |

会员到期时间要看网页 Cookie（设置 → 优酷 Cookie 导入）；没有它就只能靠取流结果判断权益。
`data/youku_creds/*.json`（或网关的 `$YOUKU_CRED_DIR`）必须落在持久化卷上，否则网关一重启
签名全失效，表现就是"刚扫完又让你重扫"。

```powershell
bun run scripts/check-yk-login.ts    # 查本机签名状态并试一次续期
bun run scripts/probe-account.ts     # cred / session / 会员接口 分段看
bun run scripts/check-sticky.ts 8    # 同一签名连打 8 次，查是不是时好时坏
bun run scripts/check-detect.ts      # 打印 TUI 实际会显示的账号行与权益徽标
```

VIP 专享片源在**非 VIP 账号**下只能拿到约 2 分 20 秒的试看段，下载会在封装时失败。
画质页右上角直接用取流结果说话：`可播 · 会员✓` / `VIP · 仅试看` / `VIP · 该账号不可播`，
先看这个再决定要不要下。

## 下载

- **画质清单**：优酷 `play` 一次给出全部档位（4K 杜比视界 / HDR Vivid / HDR10 / SDR，以及 4K 普通码、
  1080P / 720P / 480P / 360P 的 H264 与 H265 两种编码），客户端按分辨率排序、带表头列出来
  （档位 / 分辨率 / 编码 / 体积 / DRM）。只按 `media_type` 过滤音频和字幕，不再漏掉 `type=standard` 的普通码；
  只有拿到真实分片清单（`streams[].playlist_url`）的档位才会列出来。
- **翻页**：搜索结果和榜单带 `hasMore`/`nextCursor`。光标移到最后一条再按 `j` 就自动取下一页并追加，
  右上是 `1-20 / 40+`（有 `+` 表示还有下一页）。
- **音轨**：优酷会给出多条音轨（AAC / 杜比全景声 / DTS:X…）。画质页按 `←→` 切到「音轨」栏，
  **空格勾选**要封进 mkv 的那些（可多选，`a` 全选、`c` 清空），`Enter` 开始下载；
  一条不勾就只封平台默认音轨。每条音轨在 mkv 里是独立 stream，并写入标题与语言。
- **并发**：单文件（红果/腾讯/抖音）走 HTTP Range 分段并发；优酷 HLS/CMAF 分片并发拉取、写盘严格保序。
  实测同一批优酷分片（688 MB / 40 片）：`1 路 32.1s` → `8 路 7.2s`，两种方式输出 sha256 一致。
  红果单文件 4 路约 2.6 倍。线程数在 设置 → 下载线程（1~16）。
- **命名**：档位按发行规范归一（3840×1920 / 1608 这类 letterbox 画幅都写 2160p，1920×808 写 1080p），
  不再出现 1920p 这种像素当档位。
- **续传**：单文件按字节续，分片按已完成的分片续（`.partN`）。中断后重跑不会从头来。
- **阶段进度**：每个任务只显示一个总进度百分比，右侧显示当前阶段或传输字节数；下载器的阶段百分比不再重复显示。进度不倒退，只有文件处理成功才显示 100%。
- **过期链接**：CDN 返回 403/410 时先退避重试，仍失败就重新取链（红果 resolve / 腾讯 play / 优酷 play / 抖音 resolve）再继续续传。
- 重试过程写在任务行里（`重试 第 3/5 次 · HTTP 403`），进度条不会退回零。

测速度：

```powershell
$env:PROBE_HOST='http://127.0.0.1:8080'
bun run scripts/bench-download.ts 1 4 8     # 单文件：Range 并发
bun run scripts/bench-segments.ts 8 40      # 分片：串行 vs 并发，并校验 sha256
```
