# 腾讯实际版本记录

此功能记录新下载实际使用的视频版本，供下载历史和 Beflow 重命名预览核验。记录与腾讯 HQ 的命名规则分开；当前不将 `maxplus`、`suhd`、分辨率或码率自动映射为 HQ。

## 记录位置与判定

TUI 与桌面版均将已完成版本记录集中追加到 GVS 用户数据目录的 `actual-versions.jsonl`，macOS 为 `~/Library/Application Support/GVS/actual-versions.jsonl`，Windows 为 `%APPDATA%\GVS\actual-versions.jsonl`。每个有效行包含 `schemaVersion: 1`、当时的成品路径 `output` 和 `actualVersion`；读取跳过空行或因中断而损坏的行。档案独立于任务列表，清理列表后仍保留；视频目录不生成 `.gvs.json`。桌面版任务历史的 `view.actualVersion` 也保存在用户数据目录 `jobs.json`。

`selected` 是任务所选档位，`actual` 是与下载地址有对应证据的版本。只有以下证据能确认 `actual.formatId`：

- 实际地址与 `formats[]` 条目的 `url` / `playlist_url` 完全相同。
- 下载使用播放元数据的视频地址或明确列出的镜像，且视频元数据提供 `format_id` / `formatId`。普通 `video.id` 可能是视频 ID，不当作格式 ID。
- 实际地址路径中的一个完整组件与格式条目的 `fname` 相同。数字子串或文件名的一部分不算匹配。

多条地址对应的记录或明确视频元数据存在身份冲突时记为未知。没有对应证据时也记为 `status: unknown`，不能仅凭探测列表里存在某个 ID 或用户选了某版本确认默认流。镜像地址采用实际使用的地址核验；403/410 刷新后采用最后成功的视频响应。返回默认流时沿用原下载方式，版本未知不会导致下载失败。

`matchesSelection` 独立表示 `same`、`different` 或 `unknown`。缺少任一已选身份字段（例如编码版本 `persona`）时，即便格式 ID 一致也不宣称完全一致；明确字段不同则记为不同。

## 字段

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` / `provider` / `vid` | 当前版本为 1，平台为 `tencent`，视频 ID |
| `selected` / `actual` | 档位 `stream`、格式 ID `formatId`、编码版本 `persona`、字幕类型 `caption`，以及有证据的规格字段；未知实际版本可为 `null` |
| `status` / `matchesSelection` | 实际身份确认情况 / 与所选版本的对应情况 |
| `addressSource` / `evidence` | 地址来源分支 / 确认依据，不包含地址原文 |
| `recordedAt` / `refreshes` | 取链记录时间 / 本轮下载视频取链刷新次数 |
| `file` | 成品大小和 `sha256-samples-v1` 抽样指纹 |
| `media` | 本机 `ffprobe` 能读取的成品分辨率、视频编码、帧率、时长、视频码率、动态范围；不可读取时 `status: unavailable` |

`actual` 中来自网关的 `estimatedBytes` 是版本条目的估计体积；`file.size` 才是包含封装和音轨的实际成品大小。`media.videoBitrate` 只读视频流或其 `BPS` 标签，不能用包含所有音轨的容器总码率代替。没有明确动态范围信息时不补猜 SDR。`ffprobe` 只使用已安装的本机工具，没有则跳过，不额外下载工具；探测超时、不可用或伴随记录写入失败不将成功成品改成失败。

稳定身份字段经过白名单筛选。记录不含签名下载地址、内容密钥、Cookie、API Key 或网关响应原文。

## 文件核验与维护

指纹算法先加入十进制文件大小加换行，再读取首段、中段和尾段（每段最多 65536 字节，重复位置只读一次），按顺序加入“十进制偏移加换行”及该段原始字节，最后计算 SHA-256。该算法限制读取量，适合逐文件预览，能发现多种误关联；它不是完整文件哈希，不能保证发现抽样区域以外的所有改动。

Beflow 按当前文件的大小与指纹检索集中档案和任务历史，不依赖原路径或文件名，因此移动、改名、重命名撤销后仍可匹配。相同证据的重复记录可合并，实际版本冲突时不采用；不会拿所选版本替代实际版本。保留旧版 `.gvs.json` 读取兼容，但优先采用集中记录。删除视频不会清理历史档案，成品不在时无法核验；清理下载列表也不会丢失集中记录。换电脑时如需继续读取版本信息，可迁移 GVS 的集中档案。

旧成品无法仅凭历史的所选档位补出当时实际使用的版本。媒体探测可以补规格，但不能证明格式 ID / persona；本功能不改写旧任务或已有成品，新下载完成后自动产生记录。

## 本地验证

2026-10-03 使用临时目录和本机 HTTP 服务验证四种完整下载场景：所选地址确认一致、默认地址明确返回另一格式、默认地址身份未知、过期地址刷新后改变格式。验证实际下载、MKV 封装、成品探测、历史完成事件、集中记录一致及成品指纹，并确认视频旁不生成 JSON；没有用用户账号或真实网关下载来替代这些模拟验证。

对应测试：`src/lib/actual-version.test.ts`、`src/lib/gvs-record.test.ts`、`src/lib/actual-version.integration.test.ts`。跨项目指纹校验可在本机执行 `GVS_VERIFY_BEFLOW=1 GVS_BEFLOW_DIR=/path/to/Beflow bun test src/lib/gvs-record.test.ts`，其中目录需包含 `rename_core.py`；常规测试不依赖该项目。Beflow 的集中档案检索、文件核验、移动、改名、重复/冲突记录及旧记录兼容测试在其 `tests/test_rename_core.py`。
