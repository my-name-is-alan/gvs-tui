# Desktop v0.1.100

配合网关 v3.9.132。本版修掉一个长期存在、之前每版都中招的问题：**安装包里缺少 `tencent-mobile42-decode`**（`electron-builder` 对不存在的 `extraResources` 只警告并跳过），导致用户装完点腾讯下载会报"腾讯本地处理模块缺失或校验失败"。

## 安装包现在包含解码器

构建流程改为在 CI 里现编共享 Go 解码器（源码在私有网关仓库，公开仓库仍不含任何二进制或算法）：

- checkout `get_video_streaming`（`GATEWAY_PAT`，Contents 只读）
- `GVS_GATEWAY_SOURCE` 指过去，pin 校验后编译：
  - macOS arm64 / x64 → `.build/mobile42/darwin-<arch>/`
  - Windows x64 → `bin/tencent-mobile42-decode.exe`
- Windows 额外断言 exe 与 `.sha256` 存在，缺了直接失败，不再静默打出坏包

## 腾讯 App 端改为手机号登录

- 账号页：**手机号登录（原生短信，会弹官方防水墙）** + **TV 扫码**，不再有"双扫码"
- 二维码只出 **TV 一个码**（App 端不再签发网页会话码）
- 设置项 `腾讯双扫码` → `腾讯 TV 扫码`，移除 `腾讯 App 授权` 入口

## 4K 下载链路

- manifest 上限 1 MiB → 4 MiB（4K 清单实测 1.22 MiB，此前直接 `BAD_PLAN`）
- `scripts/mobile42-decoder-sources.json` 的 `playlist.go` pin 同步到网关 v3.9.132

## 仍需注意

- 手机号登录的原生票据 `vusession` 有效期约 2 小时，靠 `vurefresh` 续期；若服务端拒绝续期（`func_ret=1110002`）需要重新用手机号登录一次
- TV 端对部分内容（如剧场版）无授权，此时 TV 端取流返回空，只能用 App 端
