# 网关对接（给 TUI / UI agent）

本仓库是**本机终端客户端**。远端只有一个 HTTP 网关。用户在设置里填网关 Base URL + API Key。

**不要**去找、克隆、引用网关的 git 仓库。对接面就是本文的 HTTP 契约。

---

## 1. 边界

| 网关做 | 客户端做 |
|---|---|
| 搜、详情、取播放地址、解密钥 | 从 CDN 下载媒体 |
| 校验 API Key、限流 | 本机 FFmpeg 解密 / remux |
| 把优酷/腾讯**上游 HTTP** 转回本机隧道 | 家宽 IP 出网（`/v1/tunnel`） |
| 返回 JSON | 落盘、命名、NFO |

网关**不代下、不转发视频流**。直链过期后重新 `play` / `resolve`。

当前结构：

```text
src/Root.vue      Vue TermUI：只画 snapshot、转发按键
src/runtime.ts    状态机、HTTP、隧道、下载、扫码（Bun 同进程）
src/lib/          网关客户端 / ffmpeg / 命名
```

Vue **不要**自己 `fetch` 网关。新交互改 `runtime.ts` 的 snapshot / 按键。

配置：用户目录 `gvs/tui.json`（Windows 一般是 `%APPDATA%\gvs\tui.json`）。

---

## 2. 鉴权

所有业务请求：

```http
Authorization: Bearer sk_live_<prefix>.<secret>
```

或 `X-API-Key: sk_live_...`

同一把 Key 10 分钟内最多 2 个公网 IP。第 3 个返回 `429 IP_LIMITED`。

额外（存在才带）：

| 头 | 何时 |
|---|---|
| `Yk-Sign: yk_live_...` | 优酷 VIP 取流 / 账号相关 |
| `Tx-Cookie: ...` | 腾讯会员取流 |

扫码/Cookie 登录成功后，客户端把 `yk_sign` 存进 `tui.json` 的 `youkuSign`。腾讯网页 Cookie 存 `tencentCookie`。

---

## 3. 统一信封

成功：HTTP 200，`code` 为 `0`。

```json
{"code":0,"msg":"SUCCESS","data":{}}
```

失败：`code` 对齐 HTTP 状态，`data` 为 `null`。

| HTTP | msg 特征 |
|---|---|
| 400 | INVALID_PARAM |
| 401 | MISSING_API_KEY / INVALID_API_KEY / 需重新登录 |
| 403 | ROUTE_FORBIDDEN |
| 404 | PROVIDER_NOT_FOUND |
| 429 | RATE_LIMITED / QUOTA_EXCEEDED / CONCURRENCY_LIMITED |
| 503 | PROVIDER_UNAVAILABLE / busy |

429 可能带 `Retry-After`、`X-RateLimit-*`、`X-Quota-*`。

健康检查（无 Key）：`GET {base}/healthz` → 文本 `ok`。

---

## 4. 推荐入口 `POST /v1/invoke`

```http
POST {base}/v1/invoke
Authorization: Bearer sk_live_...
Content-Type: application/json

{"provider":"youku","action":"search","input":{"q":"庆余年","pageSize":20}}
```

规则：

- 参数只放 `input`。
- `provider` 必填（除非 `input.url` 能按域名路由）。
- `action` 缺省 = `resolve`。
- `browse` + `input.mode`：`home`/`rank` → 服务端当榜单；`category`/`filter` → 分类。

兼容路径（不要当新代码主路径）：`GET|POST /v1/{action}`、`GET|POST /{provider}/{action}`。

超时：搜索/详情约 25–30s，画质探测 45s，取流/下载 2–3min。

---

## 5. Key 自省

`GET {base}/v1/key`

```json
{
  "id": "...",
  "name": "...",
  "prefix": "...",
  "status": "active",
  "scope": ["youku","hongguo"],
  "all": false,
  "qps": 20,
  "daily": 0,
  "usedToday": 12,
  "expiresAt": null,
  "permanent": true,
  "daysLeft": null
}
```

`scope` 空且 `all: true` = 全部平台。TUI 搜索 tab 只展示 Key 允许的：`youku` `tencent` `hongguo` `douyin`。

也有 `GET /v1/key/expires`、`GET /v1/key/scope`。

---

## 6. 规范化 `data`（invoke 会做）

### search / browse

```json
{
  "items": [
    {
      "id": "...",
      "title": "...",
      "subtitle": "...",
      "cover": "https://...",
      "url": "https://...",
      "kind": "video",
      "rank": 1,
      "meta": {}
    }
  ],
  "nextCursor": "...",
  "hasMore": true,
  "raw": {}
}
```

客户端解析同时认 `items` 和旧字段 `list`。id 候选：`seriesId` | `showId` | `cid` | `vid` | `id`。`raw` 只排障。

当前 TUI 结果列表**不显示封面**，只显示 title + provider + id。

### detail

```json
{
  "id": "...",
  "title": "...",
  "cover": "...",
  "episodes": [{"id":"...","vid":"...","number":"1","title":"..."}],
  "raw": {}
}
```

集数还可能在 `ep`（数字）或 `stage`（字符串）。默认只有正片。

TUI 调 detail 的 input：

| provider | input |
|---|---|
| hongguo | `seriesId` |
| youku | `showId` + `all=1` |
| tencent | `cid` |
| 其他 | `id` |

### play / resolve

规范化会多一个 `media[]`（`url` / `quality` / `codec` / `width` / `height` / `drm`）。平台原始字段仍在：`video`、`streams`、`drm`、`qualities`。

---

## 7. 本客户端实际调用

### 7.1 优酷 `youku`

| action | input | 说明 |
|---|---|---|
| `search` | `q`, `pageSize` | 可不带 Yk-Sign |
| `browse` | `mode=rank`, `pageSize` | 榜单 |
| `detail` | `showId`, `all=1` | 正片分集 |
| `play` | `vid`；画质列表：`tier=multi` `expand=0`；下载：`expand=1`，有画质时 `tier=multi` 否则 `single` | VIP 要 Yk-Sign |
| `login` | `method=qr` `force=1` | 回 `yk_ticket`、`qrCodeUrl` |
| `login` | `method=qr` `state=check` `yk_ticket` | 确认后一次 `yk_sign` |
| `login` | `method=cookie` `cookie` | Cookie 须含 `P_sck`，回 `yk_sign` |

画质：读 `data.streams[]`，跳过 `media_type` 为 audio/subtitle，id = `stream_type`。

下载：`expand=1` 时用 `video.init_url` + `video.segment_urls`；或对选中 `stream_type` 的 `playlist_url` 自己解析 CMAF（`#EXT-X-MAP` + 分片 URI）。Referer：`https://www.youku.com/`。

DRM：`drm.content_key_hex`。本机 ffmpeg `-decryption_key`。IV 由网关解过；客户端按网关给的 hex 走。

`needs_relogin=true` 或 401 含 relogin → 重新扫码。

### 7.2 腾讯 `tencent`

| action | input |
|---|---|
| `search` | `q` |
| `browse` | `mode=rank` |
| `detail` | `cid` |
| `play` | `vid`，`defn=fhd\|shd\|hd\|sd`（缺省 fhd） |

会员带 `Tx-Cookie`。出参 `video.url`。当前客户端**拒绝 m3u8**（报「HLS 下一期」）。画质列表是写死的四档，没有探测。Referer：`https://v.qq.com/`。

`drm.enc`：0 无加密 / 1 ChaCha20 / 2 Widevine（网关不给 WV 密钥）。当前下载管线只当直链文件 remux。

### 7.3 红果 `hongguo`

匿名，只要平台 Key。

| action | input |
|---|---|
| `search` | `q`, `pageSize` |
| `browse` | `mode=rank` |
| `detail` | `seriesId` |
| `resolve` | `vid`, `platform=ios` |
| `key` | `spade` |

`resolve` 后从 `videos[vid].streams[]` 或 `video.streams[]` 选 `quality`（1080p/720p/…），URL 下载，再用 `template`/`spade` 换密钥（`key` 或 `content_key_hex`），ffmpeg 解密后 remux。`download` 动作等于 resolve，不落盘。

### 7.4 抖音 `douyin`

| action | input |
|---|---|
| `search` | `q` |
| `resolve` | `url=` 分享口令里的 `https://v.douyin.com/…` 或 `https://www.douyin.com/video/{vid}` |

下载读规范化 `media[]` 里 `type=video` 的直链。Referer：`https://www.douyin.com/`。

TUI 搜索框粘贴分享口令/短链会直接 `resolve` 并下载，不走选集和画质。短链必须把原始 `url` 交给网关（网关跟跳 `v.douyin`），不要先拆成 `video/{vid}`。

---

## 8. 家宽隧道 `GET /v1/tunnel`

优酷/腾讯的**平台上游请求**必须从用户家宽 IP 出网。Key 校验通过后：

```http
GET {base}/v1/tunnel HTTP/1.1
Host: {host}
Authorization: Bearer sk_live_...
Upgrade: tunnel
Connection: Upgrade
```

成功：`101 Switching Protocols`。之后是 **JSON 行**（`\n` 分隔）：

网关 → 客户端

```json
{"t":"req","id":"...","method":"GET","url":"https://...","header":{"User-Agent":["..."]},"body":"<base64>"}
{"t":"ping"}
```

客户端 → 网关

```json
{"t":"res","id":"...","status":200,"header":{},"body":"<base64>"}
{"t":"pong"}
{"t":"res","id":"...","err":"..."}
```

`body` 上限按实现约 6MiB。断开后每 3s 重连。隧道握手**不计**日配额。

视频 CDN **不走**隧道。

---

## 9. 本机配置 `gvs/tui.json`

```json
{
  "host": "https://你的网关",
  "key": "sk_live_...",
  "outDir": "./downloads",
  "releaseGroup": "ADWeb",
  "tmdbKey": "",
  "tmdbLang": "zh-CN",
  "youkuSign": "",
  "tencentCookie": "",
  "hongguoMerge": true,
  "hongguoNfo": true,
  "hongguoFmt": "mkv",
  "ffmpeg": "ffmpeg"
}
```

TMDB 是客户端直连 `api.themoviedb.org`，不经过网关。优酷/腾讯在填了 `tmdbKey` 时，下载前会刮削。

命名例：`NameDots.S01E02.1080p.YK.WEB-DL.H265-ADWeb.mkv`。红果/抖音短剧放在剧名目录下。

---

## 10. 画面协议（改 UI 必读）

`Root.vue` 调 `Bridge` → 同进程 `Runtime`。没有 stdin/stdout 子进程。

`set` 的 field：`query` | `host` | `key` | `edit`。

Snapshot：`src/types.ts`。场景：

`setup` → `home` → `search` / 榜单 → `results` → `detail` → `quality` →（优酷/腾讯+TMDB）`tmdb` → `jobs`

另有 `settings` `edit` `qr`。

| 场景 | 键 |
|---|---|
| 全局 | Ctrl+C 退出 |
| home | j/k Enter；`q` 退出 |
| search | ←→ 平台；Enter：抖音链接直接下载，否则搜 |
| results | j/k Enter |
| detail | 方向键；空格勾选；`a` 全选；`c` 清空；Enter/`d` 下所选；`A`/`f` 整部 |
| quality | j/k Enter |
| tmdb | j/k Enter；Esc 跳过 |
| settings | j/k Enter/空格 |
| qr | Esc 取消；2s 轮询 login check |

输入框场景（setup/search/edit）不要把普通字符再转给 Runtime，会打两遍。只转发导航键。

---

## 11. 改 UI 时不要动的

- 不要让 Vue 直接打网关。
- 不要让网关代下视频。
- 不要在客户端实现优酷/腾讯签名、ckey、号池。登录态只保存 `Yk-Sign` / Cookie。
- 不要把多个平台合成一个「social」包。
- 新功能（取消任务、海报、聚合搜、腾讯真实画质、HLS）要改 `src/runtime.ts` 和 `src/lib/`，不能只改 `Root.vue`。

栈：Bun + Vue 3 + vue-termui + OpenTUI。终端 UI，没有 DOM/CSS。组件基本是 `Box` / `Text` / `Input`。不需要 Go。
