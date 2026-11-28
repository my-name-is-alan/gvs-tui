# Desktop v0.1.102

配合网关 **v3.9.135**。修正腾讯 `em=80` / `80.9` 版权拒绝文案与诊断日志，不再把单集终端无版权（如 TV 端无授权、手机端可播）误报成「当前出口地区没有版权、请关闭 VPN 重试」。

## 修改

- `src/lib/media.ts`、`src/lib/quality.ts`、`src/lib/jobs.ts`：
  - 新增 `tencentCopyrightMessage`，按 `code=80.9` / `exem=9` 与上游文案区分「当前播放端受版权限制（非账号风控）」与出口地区版权拒绝，并在网关返回 `exinfo` 时展示上游识别出口。
  - 移除「请关闭 VPN 或切换到有版权的网络后重试」的误导性建议，避免触发重复请求或换出口撞同一内容。
  - `isTencentCopyrightRegion` 与 `tencentPlayProbeOk` 识别网关返回的 `em_stop=region_restrict`；`probeTencent` 日志补充记录 `code`、`exem`、`em_stop`、`exinfo`。
- `src/lib/media-tencent-probe.test.ts`、`src/lib/quality.test.ts`：补齐 `80.9` / `80.1` / `exinfo` / `em_stop` 回归单测。

## 验证

- `bun test src/lib/` 通过（1071 pass / 29 skip / 0 fail）。
- `bun run build` 通过。
