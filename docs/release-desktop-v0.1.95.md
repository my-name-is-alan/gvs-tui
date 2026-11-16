# Desktop v0.1.95

配套网关 **v3.9.127**，共用库同 TUI **v0.2.92**。

## 修改

- 搜索结果画质探测超时后取消详情和取流请求，避免 12 秒超时后请求继续堆在隧道上。
- 腾讯账号芯片在网关返回 `expiry=expired` 时显示「已过期」。没有到期信号时仍是未知，不把本地等待时间当成过期。

## 验证

- `bun test app/src/shared/quality-badges.test.ts` 通过。
- `bunx tsc --noEmit -p app/tsconfig.node.json` 通过。
