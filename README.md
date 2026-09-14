# GVS TUI

本机终端下载器。只通过 HTTP 调远端网关（地址和 API Key 由用户填写）。

服务端不代下媒体。优酷/腾讯上游请求经 `/v1/tunnel` 从本机 IP 出网；CDN 由本机直拉。

**对接契约：** [docs/GATEWAY.md](docs/GATEWAY.md)（给改 UI 的 agent 只看这一份）。

## 运行

需要 Bun ≥ 1.3、Go 1.26+（开发时编桥）、[ffmpeg](https://ffmpeg.org/)。

```powershell
bun install
bun run dev
```

第一次填网关 Base URL（`https://你的域名`）+ 管理台发的 API Key。配置在用户目录 `gvs/tui.json`。

```powershell
bun run build
bun run start
```

桥接程序在本地 `bin/`，不入库。可设 `GVS_TUI_BRIDGE` 指向已编译的二进制。`Ctrl+C` 退出。

## 结构

```text
docs/GATEWAY.md   网关 HTTP / 隧道 / 桥协议
cmd/tui/          状态机、网关客户端、隧道、下载、扫码
src/              Vue TermUI（只渲染 snapshot、转发按键）
scripts/          编译隐藏 Go 桥
```

Vue 不 `fetch` 网关。新交互要同时改 `cmd/tui` 的 snapshot / 按键。
