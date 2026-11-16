# TUI v0.2.92

配套网关 **v3.9.127**。搜索画质探测超时后会取消已经发出的请求，腾讯账号状态能显示登录是否过期。

## 修改

- 搜索徽标队列到时限后中止对应网关请求，不再只停止等待、让详情和取流继续占隧道。
- 腾讯账号摘要读取 `expiry`。已判定过期时显示「已过期」，不再一律显示已登录。
- `em=80` 版权地区拒绝先于权益锁判断，不再把「受版权限制」报成账号风控。

## 验证

- `bun test src/lib/tencent-account.test.ts src/lib/quality.test.ts src/lib/media-tencent-probe.test.ts` 通过。
- 桌面端类型检查 `tsc --noEmit -p app/tsconfig.node.json` 通过。
