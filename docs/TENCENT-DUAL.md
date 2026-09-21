# 腾讯：双扫码 / 双流 / HTML 链接

## 双扫码（App + TV）

设置 → **腾讯双扫码**：同时向网关请求 `method=app` 与 `method=tv`（TV 默认 `tv_fp_profile=virtual_ott_4k`，可用环境变量 `TENCENT_TV_FP_PROFILE` 覆盖），保存两张官方 PNG 并并行轮询。两路都登录成功后，默认把播放会话切到极光 TV（默认播放会话为极光 TV）。


## 两个视频流

详情页多选 **最多先探测 2 集**：确认画质前会用网关 `play` 的 `vid`+`vid2` 双流探测。任务队列本身最多并发 2 个下载，腾讯任务可并行取流。

粘贴两条 `v.qq.com` / `m.v.qq.com` HTML 页链接时，会解析成两个播放目标（双链详情）。

## HTML 链接解析

搜索框 / 粘贴：支持 `v.qq.com`、`m.v.qq.com`、`film.qq.com` 页链接（含分享文案里的 URL）。优先 `cid` 进详情选集；仅 `vid` 或双链则走 resolve。

网关侧：`POST /tencent/resolve` 与 `play` 的 `vids`/`vid2`/`url2` 见 gateway `docs/api/tencent.md`。
