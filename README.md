# GVS TUI

本机终端下载器。独立仓库，只通过 HTTP 调远端网关。

```text
网关（单独仓库 get_video_streaming）  ←  API Key + /v1/invoke + /v1/tunnel
本仓库 gvs-tui                       ←  搜索 / 选集 / 下载 / 家宽隧道 / FFmpeg
```

服务端不代下媒体。优酷/腾讯上游请求经 `/v1/tunnel` 从本机 IP 出网；CDN 由本机直拉。

## 运行

需要 Bun ≥ 1.3、Go 1.26+（开发时编桥）、[ffmpeg](https://ffmpeg.org/)。

```powershell
bun install
bun run dev
```

第一次填：网关地址（例如 `https://你的域名`）+ 管理台发的 API Key。配置在用户目录 `gvs/tui.json`。

生产：

```powershell
bun run build
bun run start
```

桥接程序在本地 `bin/`，不入库。可设 `GVS_TUI_BRIDGE` 指向已编译的 `gvs-tui-bridge`。

`Ctrl+C` 退出。

## 仓库结构

```text
cmd/tui/     Go 状态机、网关客户端、隧道、下载管线、扫码
src/         Vue TermUI 画面（只渲染 snapshot、转发按键）
scripts/     编译隐藏 Go 桥
```

Vue 不 `fetch` 网关。新交互要同时改 `cmd/tui` 的 snapshot / 按键。

## 网关

网关仓库：https://github.com/my-name-is-alan/get_video_streaming

客户端契约：`POST /v1/invoke`、`GET /v1/key`、`GET /v1/tunnel`。
