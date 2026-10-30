# Desktop v0.1.93

配套 TUI **v0.2.91** / 网关 **v3.9.121**（最低 v3.9.120）。桌面端与 TUI 共用 `src/lib`，
这一版把腾讯下载侧的两个修复带进安装包。

## 一、腾讯 CDN 坏主机自动换镜像

腾讯 `getvinfo` 随机给出的 CDN 里，`ltscsy.qq.com` 对部分出口返回 **HTTP 200 但内容是
191 字节的 `Forbidden` HTML**，下载器按「不是 m3u8」处理会整轨失败：

```
download failed: 所有 CDN 都没有返回播放列表：ltscsy.qq.com HTTP 200
```

同一路径在 `ltstyyy / ltstysj / ltsbdy / ltsxmty .gtimg.com` 四台镜像上都是正常清单
（200 + 23379 B）。现在 `tencentMirrors()` 会为 `lts*.qq.com` 追加**同路径 gtimg 候选**，
配合网关新补的 `video.urls`（上游多镜像），任一主机可用即可继续下载。

## 二、画质页默认探软/硬两套档位

- 默认 `caption=all`：同一集从 5 行（`hd/shd/fhd/uhd/maxplus`）变 10 行（软、硬各一套），
  实测只多约 225ms；
- 新增 `tencentFullLadder`（默认关）：`defn=full` 逐档喷洒，例如尚公主第 1 集 17 行，
  多出 `hdr10`（3840×2160）与 `suhd`（3840×2160 1.75GB），代价 3.6s、请求数 1→9。

## 三、配套网关（v3.9.121）在桌面端的效果

- `play` 的 `video` 现在带 `urls / format_id / defn / 尺寸`，桌面端能看出实际下发的档位，
  不再出现「选了 suhd(490MB) 却静默下成 uhd(307MB)」；
- TV 会话路径的 `format_id` 按目录 id 归一，不会把同一条流误判成「实际版本与所选版本不同」。

## 验证

- `bunx tsc --noEmit` 无错误；`vue-tsc -p tsconfig.web.json`、`tsc -p tsconfig.node.json` 通过；
- `bun test --timeout 60000 src/lib`：**1028 pass / 35 skip / 0 fail**（1063 用例 / 138 文件）；
- 安装包由桌面端 Release 工作流构建（`desktop-v*` 标签与 `app/package.json` 版本一致）。

## 回滚

回退 `desktop-v0.1.92`。
