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
docs/GATEWAY.md   网关 HTTP / 隧道 / 画面协议
src/Root.vue      终端画面
src/runtime.ts    状态机、网关、隧道、下载、扫码
src/lib/          HTTP 客户端 / ffmpeg / 命名
```

Vue 不直接 `fetch` 网关；通过 `Runtime` 同进程调用。
