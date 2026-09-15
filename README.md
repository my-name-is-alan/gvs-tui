# GVS TUI

本机终端下载器。Bun 单进程：Vue TermUI 画面 + TypeScript 运行时。只通过 HTTP 调远端网关（地址和 API Key 由用户填写）。

服务端不代下媒体。优酷/腾讯上游请求经 `/v1/tunnel` 从本机 IP 出网；CDN 由本机直拉。

**对接契约：** [docs/GATEWAY.md](docs/GATEWAY.md)

## 运行

需要 Bun ≥ 1.3、[ffmpeg](https://ffmpeg.org/)。不需要 Go。

```powershell
bun install
bun run dev
```

第一次填网关 Base URL + 管理台发的 API Key。配置在用户目录 `gvs/tui.json`。

```powershell
bun run build
bun run start
```

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
src/lib/              HTTP 客户端 / ffmpeg / 命名
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

