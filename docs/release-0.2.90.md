# TUI v0.2.90

配套网关 **v3.9.120**（最低 v3.9.119）。修 **Apple TV 画质页不显示 HDR**。

## 问题

Apple TV 的动态范围在画质 ID 里是 `PQ` 或 `HLG`，例如 `2160|DV|PQ|24`。画质徽章和 TUI 的
HDR 列只认字面 `HDR`，所以 `PQ` / `HLG` 的档位徽章空着、HDR 列也是空的 —— 明明是可用的
HDR10 / HLG 母版。杜比视界因为单独匹配，不受影响。

## 改动

- `qualityHdrText`（`src/lib/quality.ts`）：`pq` / `hlg` 与 `hdr` 一样显示 `HDR`；
- `hdrKind`（`app/src/shared/media-specs.ts`，桌面端共用）：正则补
  `(^|[\s_|])pq([\s_|]|$)` 与 `hlg`，命中即 `HDR`；杜比视界仍先匹配并优先显示「杜比视界」；
- `probeManifest`（`src/lib/manifest-provider.ts`）：`hdr` 不再只取 `q.hdr`，回退顺序为
  `hdr → dynamicRange → videoRange →` 画质 ID 的第三段（`2160|DV|PQ|24` → `PQ`），
  探测结果没有单独动态范围字段时也能补上；
- 测试：`appletvplus-download` 断言 `2160|DV|PQ|24` 保留 `hdr='PQ'`、`1080|H264|SDR|24` 为 `hdr='SDR'`。

## 行为对照

| 画质 ID | 之前 | 现在 |
|---|---|---|
| `2160\|DV\|PQ\|24` | 徽章空 / HDR 列空 | 杜比视界（DV 优先）；HDR 列 `PQ` 认作 HDR |
| `2160\|H264\|HLG\|25` | 不显示 HDR | HDR |
| `1080\|H264\|SDR\|24` | 不显示 | 不显示（SDR） |

## 验证

- `bunx tsc --noEmit` 无错误；桌面端 `vue-tsc -p tsconfig.web.json`、`tsc -p tsconfig.node.json` 均通过；
- `bun test --timeout 60000 src/lib`：**1026 pass / 35 skip / 0 fail**（1061 用例 / 138 文件）；
- PR 自带用例：`appletvplus-download` / `appletvplus-import-quality` 共 15 通过。

## 回滚

回退 `v0.2.89`。
