# 发现接口 v1 与平台工作台

TUI 只依赖 HTTP 契约。先部署提供本接口的网关，再升级客户端；旧网关显示“兼容模式”。本次实现未提交、推送、打 tag 或部署。

## 请求

沿用 `POST /v1/invoke`，Authorization 为已有 Bearer Key。

```json
{"provider":"hongguo","action":"browse_catalog","input":{}}
```

成功 envelope 的 `data` 包含 `version: 1`、`fetchedAt`、`sections`。每个栏目有：

- `id`：传给 browse 的稳定 sectionId，客户端不可用数字序号推断类别。
- `title`、`mode`（home/rank/category）、`contentType`（recommendation/rank）。
- `available`、`reason`、`paginated`。
- `filters`：key/title/options，每个选项有 value/label。

```json
{"provider":"hongguo","action":"browse","input":{"mode":"rank","sectionId":"rank:recommend","genre":"human"}}
```

下一页必须使用响应游标，并把已见 seriesId 以逗号分隔传回：

```json
{"provider":"hongguo","action":"browse","input":{"mode":"rank","sectionId":"rank:recommend","genre":"human","cursor":"12","seenIds":"series-id-a,series-id-b"}}
```

数字仅为请求示例，不能据此假定真实游标始终加 12。旧 mode/参数保持原有路由；有 sectionId 时使用新栏目路由。不要直接调用内部 `browse_section`。

## 响应与打开目标

列表保留 `items`、`hasMore`、`nextCursor`、`raw`，附带 `sectionId`、`source`、`contentType`、`category`、`availability`、`fetchedAt`，可有 `notice`。不可用栏目返回空列表、availability=unavailable 和原因；上游请求失败使用原有非零错误 envelope。

条目包含 id/title/subtitle/cover/kind/rank/meta/target。没有 ID 时 id 为空字符串，绝不制造 ID。rank 为 0 表示没有排名；TUI 只在榜单且 rank>0 时显示名次。

- `target: {type:"detail",id:"..."}`：打开该剧详情。
- `target: {type:"search",query:"..."}`：搜索候选，由用户选择。
- `target: {type:"channel",sectionId:"..."}`：继续浏览频道。
- `target: {type:"unavailable",reason:"..."}`：显示预约等不可下载原因。

广告、预告不会作为可下载条目；预约榜保留榜单身份，但条目明确不可下载。上游没有明确排名字段时，红果新版发现接口保留原顺序、不编造名次。旧 rank 接口未改语义以兼容原客户端。

## 平台能力

优酷 `recommend` 使用 TV recommend.get，属于平台推荐，单页结束。`rank` 当前明确不可用，不把推荐排列或网页扫描顺序当作真实榜单。

腾讯 `recommend` 当前明确不可用。榜单解析实际分组名称，以 `rank:<上游榜名>` 为栏目 ID；有明确 CID 才直接进入详情，否则标题搜索。没有静默推荐→热搜回退。

红果 `theatre:0` 是公开剧场；频道条目继续打开 theatre 栏目。榜单为 `rank:recommend|hot|real|new|zhenguo|subscribe`，支持 genre=all/human/comic/ai。seenIds 去重不重新编号；重复页面或游标不前进时停止。

## 客户端缓存和状态

栏目和列表按平台、栏目、筛选隔离缓存 5 分钟。R 强制重新获取栏目与当前内容，传 refresh=1；网关发现适配器直接请求上游，无额外本地列表缓存。切换页面丢弃旧响应；同一活动游标只发一次。列表位置在详情返回、切平台、切栏目和任务/设置返回时恢复。

兼容模式只在明确不支持 browse_catalog 时启用；认证失败、403、普通网络错误不会被伪装成兼容模式。旧网关能力有限：优酷仅确认来源的推荐、腾讯热搜、红果旧榜单；新剧场需升级网关。

## 下载确认

内容详情只选集；下一步画质/音轨，再可选 TMDB 匹配，最后确认节目、集数、目录及命名示例。Esc 不入队，只有最终确认页的 Enter 才调用现有队列。腾讯沿用已有画质档位选项，但在最终确认前调用已有 play 接口验证所选画质；失败停在设置页，可重试。此实现不改变腾讯凭据或播放协议。

任务日志在 TUI 内保留最近 1000 条状态记录，按终端宽度折行、支持滚动；不增加任务取消、暂停或重试能力。
