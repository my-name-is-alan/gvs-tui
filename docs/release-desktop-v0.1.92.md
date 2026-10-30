# Desktop v0.1.92

配套 TUI **v0.2.90** / 网关 **v3.9.120**（最低 v3.9.119）。桌面端与 TUI 共用 `src/lib`，
这一版把 **TUI v0.2.89 / v0.2.90** 的两处修复同步到安装包：

## 一、腾讯「返回的实际版本与所选版本不同」误判（TUI v0.2.89）

旧逻辑在下载前比对实际 rendition 与所选档位时，把「所选字幕」取的 `caption_probe`
当成已证实字幕。probe 只表示这行用哪种 persona 探测（默认 `soft`），实际返回没有
`caption` 字段时就判成不同版本，桌面端直接停下载。

- `tencentDownloadSelection`：取流请求仍按探测方式带 `caption`（避免网关换档），
  返回值只保留目录**已证实**的 `caption`（`soft` / `hard`）；
- `equivalentTencentRendition`：比对改用 `selected.captionProbe || input.caption` 折算的请求字幕；
  分集格式 ID 重绑仍按请求探测字幕匹配，档位不放宽；
- 真的不符（目录证实软、实际返回硬）仍判不同。

桌面端影响：probe-only 档位（画质表里最常见）不会再莫名报版本不符并中断下载。

## 二、Apple TV 画质页不显示 HDR（TUI v0.2.90）

动态范围在画质 ID 里是 `PQ` / `HLG`（如 `2160|DV|PQ|24`），界面只认字面 `HDR`，
于是徽章与 HDR 列全空。

- `app/src/shared/media-specs.ts` 的 `hdrKind`：正则补 `(^|[\s_|])pq([\s_|]|$)` 与 `hlg`，
  命中即 `HDR`；**杜比视界仍先匹配并优先显示**；
- `qualityHdrText`（共用库）：`pq` / `hlg` 同样显示 `HDR`；
- `probeManifest`：`hdr` 回退链 `hdr → dynamicRange → videoRange →` 画质 ID 第三段，
  探测没有单独动态范围字段时也能补上。

桌面端影响：Apple TV 的 HDR10（PQ）/ HLG 母版档，画质页徽章与 HDR 列恢复显示。

## 验证

- `bunx tsc --noEmit` 无错误；
- 桌面端 `vue-tsc --noEmit -p tsconfig.web.json`、`tsc --noEmit -p tsconfig.node.json` 均通过；
- `bun test --timeout 60000 src/lib`：**1026 pass / 35 skip / 0 fail**（1061 用例 / 138 文件）；
- 安装包由桌面端 Release 工作流构建（`desktop-v*` 标签与 `app/package.json` 版本一致）。

## 回滚

回退 `desktop-v0.1.91`。
