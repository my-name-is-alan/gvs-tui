import type { Audio, Job, Quality, Snapshot } from '../types'
import { clip, displayWidth, wrapLines } from './text'

export function splitPane(width: number) {
  const side = width >= 118 ? Math.max(32, Math.min(42, Math.floor(width * 0.28))) : 0
  return { main: width - (side ? side + 2 : 0), side }
}

/** Shared budgets keep PageUp/PageDown aligned with the rendered list. */
export function viewMetrics(width: number, height: number) {
  const bodyWidth = Math.max(24, width) - 2
  const bodyHeight = Math.max(3, Math.max(8, height) - (height >= 18 ? 4 : 3))
  const pane = splitPane(bodyWidth)
  const jobPanel = Math.min(10, Math.max(6, Math.floor(bodyHeight * 0.45)))
  return {
    bodyWidth, bodyHeight, pane, jobPanel,
    scrollRoom: Math.max(1, bodyHeight - 2),
    qualityRows: Math.max(1, bodyHeight - 8),
    jobRows: Math.max(1, bodyHeight - (pane.side ? 2 : jobPanel + 3)),
    jobLogRows: Math.max(1, bodyHeight - 4),
    settingRows: Math.max(1, bodyHeight - (pane.side ? 2 : 9)),
    gridRows: Math.max(1, bodyHeight - (pane.side ? 4 : 5)),
  }
}

export type QualityColumn = { key: 'label' | 'codec' | 'size' | 'hdr' | 'fps' | 'caption' | 'resolution' | 'drm'; title: string; width: number }
/** Allocate optional columns only after reserving readable names and required fields. */
export function qualityColumns(width: number, rows: Quality[]): QualityColumn[] {
  const cols: QualityColumn[] = [
    { key: 'codec', title: '编码', width: 8 },
    { key: 'size', title: '体积', width: 9 },
  ]
  let used = 2 + 18 + cols.reduce((n, c) => n + c.width + 2, 0)
  const optional: Array<QualityColumn & { show: boolean }> = [
    { key: 'hdr', title: 'HDR', width: 8, show: rows.some(q => !!q.hdr) },
    { key: 'fps', title: 'fps', width: 5, show: rows.some(q => !!q.fps) },
    { key: 'caption', title: '字幕', width: 8,
      show: rows.some(q => !!q.caption || !!q.captionProbe) },
    { key: 'resolution', title: '分辨率', width: 11, show: true },
    { key: 'drm', title: 'DRM', width: 3, show: rows.some(q => !!q.drm) },
  ]
  for (const col of optional) {
    if (col.show && used + col.width + 2 <= width) { cols.push(col); used += col.width + 2 }
  }
  const order = ['resolution', 'caption', 'hdr', 'fps', 'codec', 'size', 'drm']
  cols.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  const labelRoom = width - 2 - cols.reduce((n, c) => n + c.width + 2, 0)
  const labelWidth = rows.reduce((n, row) => Math.max(n, displayWidth(row.label || row.title || '') + 3), 18)
  return [{ key: 'label', title: '档位', width: Math.min(labelRoom, labelWidth) }, ...cols]
}

export function episodeRanges(numbers: number[]): string {
  const values = [...new Set(numbers)].sort((a, b) => a - b)
  const ranges: string[] = []
  for (let i = 0; i < values.length; i++) {
    const start = values[i]!
    let end = start
    while (values[i + 1] === end + 1) end = values[++i]!
    ranges.push(start === end ? String(start) : `${start}–${end}`)
  }
  return ranges.join('、')
}

export function selectedAudioText(audios: Audio[]): string {
  const picked = audios.filter(a => a.selected)
  return picked.length ? picked.map(a => [a.lang && a.lang !== '—' ? a.lang : '', a.label].filter(Boolean).join(' ')).join(' / ') : '平台默认音轨'
}

export function boundedLines(lines: string[], width: number, height: number, more = '更多内容请查看详情'): string[] {
  const wrapped = lines.flatMap(line => wrapLines(line, width))
  if (wrapped.length <= height) return wrapped
  return [...wrapped.slice(0, Math.max(0, height - 1)), clip(`… ${more}`, width)]
}

export function jobSummary(job: Job | undefined, width: number): string[] {
  if (!job) return ['选择任务后查看进度、错误或保存位置']
  return [clip(job.title, width), `${job.status === '失败' && job.phase ? '失败阶段' : '阶段'}：${job.phase || job.status} · ${Math.round(job.pct * 100)}%`,
    ...(job.err ? [`失败原因：${job.err}`] : []),
    ...(job.note ? [`提示：${job.note}`] : []),
    ...(job.log ? [`${job.status === '完成' ? '保存位置' : '进度'}：${job.log}`] : []),
  ]
}

export function settingGroup(label: string): string {
  if (['隧道', '网关', '网关代理', 'Key'].includes(label)) return '连接'
  if (['下载目录', '下载线程', '发布组', '文件名单集标题'].includes(label)) return '下载'
  if (label.startsWith('TMDB')) return '匹配'
  if (label.startsWith('优酷')) return '优酷'
  if (['腾讯 caption=all', '腾讯探测原画', '腾讯 encode=all'].includes(label)) return '腾讯高级'
  if (label.startsWith('腾讯')) return '腾讯'
  if (label.startsWith('红果')) return '红果'
  if (label.startsWith('黄果')) return '黄果'
  if (label.startsWith('抖音')) return '抖音'
  if (label.startsWith('爱奇艺国内版')) return '爱奇艺国内版'
  if (label.startsWith('mewatch')) return 'mewatch'
  if (label.startsWith('Hami')) return 'Hami'
  return '诊断'
}

export function settingDescription(label: string): string {
  const help: Record<string, string> = {
    '隧道': '优酷、腾讯请求通过本机网络出口。回车重新连接。',
    '网关': '填写网关 Base URL。', 'Key': '用于访问网关的 API Key。',
    '网关代理': '网关 API 和隧道共用的 HTTP/HTTPS 代理，保存后重新连接。只填代理端口地址，不要填 PAC 地址。留空直连；启动环境代理优先。',
    '下载目录': '成品保存目录。完整路径显示在下方。',
    '下载线程': '每个下载使用的连接数：1–16。',
    '发布组': '追加到成品文件名末尾的发布组名称。',
    '文件名单集标题': '在季集号后加入平台单集标题。默认开启，回车切换；仅影响新任务，已入队任务沿用创建时的设置，电影不受影响。',
    'TMDB Key': '支持 API Key 或 API Read Access Token。',
    'TMDB 代理': '仅用于 TMDB 的 HTTP/HTTPS 代理。留空使用默认网络；不要填写 PAC 地址。',
    '优酷登录': '回车续期并刷新会员状态。', '腾讯登录': '回车刷新账号与会员状态。',
    '腾讯 caption=all': '高级选项：探测软、硬字幕，增加取流请求。',
    '腾讯探测原画': '高级选项：探测原画，可能触发平台权益限制。',
    '腾讯 encode=all': '高级选项：探测全部编码，可能触发平台风控。',
    '运行日志': '排查连接、匹配和下载问题时查看此文件。',
  }
  return help[label] || '回车修改或执行此项操作。修改后立即保存。'
}

export function settingInfoLines(label: string, value: string): string[] {
  return [settingDescription(label), '', value]
}

export function compactSetting(label: string, value: string): string {
  return /登录/.test(label) ? value.split(/\s*·\s*/).filter(part => !/^(uid\s|上次续期)/i.test(part)).join(' · ') : value
}

export function confirmationLines(info: NonNullable<Snapshot['confirmation']>, width: number): string[] {
  return [
    ...wrapLines(info.title, width),
    `${info.kind === 'movie' ? '电影' : '剧集'}${info.year ? ` · ${info.year}` : ''}`,
    ...wrapLines(`${info.kind === 'movie' ? '版本' : '集数'}：${info.episodes}`, width),
    ...wrapLines(`画质：${info.quality}`, width),
    ...wrapLines(`音轨：${info.audio}`, width),
    '', '保存目录', ...wrapLines(info.directory, width),
    '', '文件名示例', ...wrapLines(info.name, width),
    ...(info.note ? ['', ...wrapLines(info.note, width)] : []),
  ]
}

export type KeyHint = [string, string]
/** Callers order actions by priority. Keep help discoverable even when other hints are omitted. */
export function fitHints(hints: KeyHint[], width: number): KeyHint[] {
  const all = hints.some(([key]) => key === 'F1') ? hints : [...hints, ['F1', '帮助'] as KeyHint]
  const measure = (items: KeyHint[]) => items.reduce((n, [k, v]) => n + displayWidth(k) + 1 + displayWidth(v), 0) + Math.max(0, items.length - 1) * 3
  if (measure(all) <= width) return all
  const help = all.find(([k]) => k === 'F1')!
  const back = all.find(([k]) => k === 'esc')
  const required = back && measure([back, help]) <= width ? [back, help] : [help]
  const kept: KeyHint[] = []
  for (const hint of all.filter(([k]) => k !== 'esc' && k !== 'F1')) {
    if (measure([...kept, hint, ...required]) <= width) kept.push(hint)
  }
  return [...kept, ...required].filter((_, i, rows) => measure(rows.slice(0, i + 1)) <= width)
}

export const HELP_LINES = [
  '怎么用',
  '',
  '发现页',
  '  1-7     切平台：1 优酷  2 腾讯  3 红果  4 黄果  5 抖音  6 mewatch  7 Hami',
  '  ← →    换栏目；只有一个栏目时，左右切推荐/榜单',
  '  Tab     推荐 / 榜单',
  '  回车    打开    / 搜索    F 筛选    R 刷新',
  '',
  '下载（确认页回车才入队，Esc 不会入队）',
  '  空格勾选   Shift+方向从当前集连选   A 全选   C 清空',
  '  回车：选集 → 画质 → 匹配 → 确认',
  '  详情页 I 展开简介；优酷/腾讯/IQ M 切换电影/剧集',
  '  确认页 ↑↓ / PgUp / PgDn 查看完整目录与文件名',
  '  任务页 ↑↓ 选任务，回车查看完整错误和日志',
  '  设置页 ←→ / Tab 切换分组，I 查看详情',
  '  画质页 ←→ 切到音轨，空格勾选要封装的音轨',
  '  TMDB：回车采用类型和片名，S 跳过，R 只重试匹配',
  '',
  'F1 帮助   F2 搜索   F3 任务   F4 设置',
  'Esc 返回    Ctrl+C 退出',
  'Windows Terminal 会吃掉 Alt+数字，用 Ctrl+1/2/3/4',
]
