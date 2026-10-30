# TUI v0.2.91

配套网关 **v3.9.121**（最低 v3.9.120）。修 **腾讯播放地址落到坏 CDN 时整轨失败**，
并把画质页默认改成 **软/硬两套档位都探**。

## 一、腾讯 CDN 镜像回退

腾讯 `getvinfo` 每次随机返回一台 CDN 主机，其中 `ltscsy.qq.com` 对部分出口返回
**HTTP 200 但内容是一段 191 字节的 `Forbidden` HTML**（gb2312），播放器/下载器按
「不是 m3u8」处理就整轨失败：

```
download 1 failed: 所有 CDN 都没有返回播放列表：ltscsy.qq.com HTTP 200
```

实测同一路径换到 `ltstyyy / ltstysj / ltsbdy / ltsxmty .gtimg.com` 四台镜像全部
返回 `200 application/vnd.apple.mpegURL`（23379 B）：

- `tencentMirrors()` 现在对 `lts*.qq.com` 的播放地址追加**同路径 gtimg 镜像**；
- 已经在 `gtimg.com` 上的地址不再额外造候选；
- 与网关补的 `video.urls`（多条上游镜像）叠加生效，任一主机可用即可开下。

## 二、画质页默认探软/硬两套（`caption=all`）

此前画质页只探 `caption=soft`，一集只有 5 行（`hd/shd/fhd/uhd/maxplus`）。现在默认
`caption=all`，同一集 10 行（软、硬各一套），实测只多 ~225ms，无风控代价；显式
`tencentCaptionAll: false` 才退回只探 soft。

新增 `tencentFullLadder`（默认关）：走 `defn=full` 逐档喷洒，尚公主第 1 集从 10 行
扩到 **17 行**，多出 `hdr10`（3840×2160 / 1920×1080）与 `suhd`（3840×2160 1.75GB）。
代价 3.6s、请求数 1→9，风控更敏感，按需开。

| probe 参数 | 行数 | 耗时（尚公主 ep1） |
|---|---|---|
| `caption=soft`（旧默认） | 5 | 575ms |
| `caption=all`（新默认） | 10 | 800ms |
| `caption=all&defn=full`（`tencentFullLadder`） | 17 | 3660ms |

## 三、配套网关改动（v3.9.121）

- `play` 的 `video` 补 `urls` / `format_id` / `defn` / `width` / `height` / `duration`
  —— 此前这条收尾只写 `url` + `playlist_url`，客户端既没有镜像可回退，也看不出
  「请求 suhd、服务端只给 uhd」的降档；
- TV 路径的 `format_id` 按目录 id 归一（`f322100001` → `322100`），不再让客户端把
  同一条流判成「实际版本与所选版本不同」；
- 本地 `app.local.json` 的 `tencent.timeout` 15s → 30s：搜索接口首包在隧道刚重连时
  会超过 15s，15s 超时表现为「搜索没反应」。

## 验证

- `bunx tsc --noEmit` 无错误；
- `bun test --timeout 60000 src/lib`：**1028 pass / 35 skip / 0 fail**（1063 用例 / 138 文件）；
- 实网：`play?vid=v4102hrb7cq&session_type=tv&caption=all` 返回 10 行；
  `&defn=full` 返回 17 行（含 hdr10 / suhd）；
- 坏 CDN 场景：`ltscsy.qq.com` 200 Forbidden → 同路径 `ltstyyy.gtimg.com` 200 m3u8。

## 回滚

回退 `v0.2.90`。
