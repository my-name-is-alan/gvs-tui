<script setup lang="ts">
/**
 * GVS terminal UI.
 *
 * The shell is fixed: a header bar, an optional hairline rule, a content
 * region, a status line and a key-hint footer. Content rows are single
 * `<Text>` renderables built by `colsLine`, so every scene lines up on the
 * same columns and nothing reflows when a status message appears.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue-termui'
import {
  Box,
  Input,
  StyledText,
  Text,
  bg,
  bold,
  fg,
  onKeyDown,
  useExit,
  useInterval,
  useTerminalSize,
  useTitle,
} from 'vue-termui'
import { Bridge, type Snapshot } from './bridge'
import type { TextChunk } from 'vue-termui'
import EpisodeGrid from './components/EpisodeGrid.vue'
import KeyHints from './components/KeyHints.vue'
import Spinner from './components/Spinner.vue'
import {
  barChunks,
  colsLine,
  descLine,
  ink,
  kvLine,
  markCol,
  pickLine,
  tabChunks,
  tabsWidth,
} from './lib/rows'
import type { Col } from './lib/rows'
import { clip, column, displayWidth, padStart, wrapLines } from './lib/text'
import { qualityCaptionText, qualityFpsText, qualityHdrText, qualityResolution } from './lib/quality'
import { human } from './lib/util'
import {
  c,
  hostLabel,
  jobTone,
  providerName,
  toneColor,
  valueColor,
} from './lib/theme'
import type { Audio, Episode, Job, Quality, Row } from './types'

const exit = useExit()
const bridge = new Bridge()
const state = ref<Snapshot>(bridge.snapshot)
const query = ref('')
const searchField = ref<{ $el?: { focus?: () => void } } | null>(null)
const host = ref('')
const key = ref('')
const edit = ref('')
const { width, height } = useTerminalSize()
const hostField = ref<{ $el?: { focus?: () => void } } | null>(null)
const keyField = ref<{ $el?: { focus?: () => void } } | null>(null)
const editField = ref<{ $el?: { focus?: () => void } } | null>(null)

function focusField(comp: { $el?: { focus?: () => void } } | null | undefined) {
  const fn = comp?.$el?.focus
  if (typeof fn === 'function') fn.call(comp.$el)
}

watch(
  () => state.value.scene,
  (scene) => {
    queueMicrotask(() => {
      if (scene === 'search') focusField(searchField.value)
      else if (scene === 'edit') focusField(editField.value)
      else if (scene === 'setup')
        focusField(state.value.hostFocused ? hostField.value : keyField.value)
    })
  },
)
watch(
  () => state.value.hostFocused,
  (on) => {
    if (state.value.scene !== 'setup') return
    queueMicrotask(() => focusField(on ? hostField.value : keyField.value))
  },
)

const stop = bridge.onSnapshot((next) => {
  state.value = next
  if (next.scene !== 'search') query.value = next.query ?? query.value
  if (next.scene === 'setup') host.value = next.hostInput ?? host.value
  if (next.scene === 'edit') edit.value = next.editValue ?? edit.value
})

onMounted(() => {
  query.value = state.value.query ?? ''
  host.value = state.value.hostInput ?? state.value.host
})
onUnmounted(() => {
  stop()
  bridge.close()
})

watch(query, (value) => {
  if (state.value.scene === 'search') bridge.set('query', value)
})
watch(host, (value) => {
  if (state.value.scene === 'setup') bridge.set('host', value)
})
watch(key, (value) => {
  if (state.value.scene === 'setup') bridge.set('key', value)
})
watch(edit, (value) => {
  if (state.value.scene === 'edit') bridge.set('edit', value)
})

onKeyDown((event) => {
  const name = event.name.toLowerCase()
  if (event.ctrl && name === 'c') {
    exit()
    return
  }
  if (name === 'q' && state.value.scene === 'home') {
    exit()
    return
  }

  // Platform switch:
  // - Alt/⌥+1..3: Mac Option sets event.option; many terminals send ESC+digit as event.meta
  // - Ctrl+1..3: Windows Terminal often steals Alt+digit for tab switching
  // - Never ⌘/super+digit (iTerm/VS Code/Finder window switching)
  const digit = ['1', '2', '3'].includes(name)
  const altLike = !!(event.option || event.meta) && !event.super
  const platformShortcut = digit && (altLike || event.ctrl)
  if (platformShortcut || /^f[1-4]$/.test(name)) {
    bridge.key(event.name, {
      ctrl: event.ctrl,
      alt: altLike || (event.ctrl && digit),
      shift: event.shift,
    })
    event.preventDefault()
    return
  }
  if (state.value.scene === 'search') {
    if (['enter', 'return', 'escape', 'esc', 'tab'].includes(name)) {
      bridge.key(event.name, { shift: event.shift })
      event.preventDefault()
    }
    return
  }
  const inputScene =
    state.value.scene === 'setup' || state.value.scene === 'edit'
  const navigationKey = [
    'enter',
    'return',
    'escape',
    'esc',
    'tab',
    'left',
    'right',
    'up',
    'down',
    'arrowleft',
    'arrowright',
    'arrowup',
    'arrowdown',
  ].includes(name)
  if (inputScene) {
    if (['enter', 'return', 'escape', 'esc', 'tab'].includes(name)) {
      bridge.key(event.name, { shift: event.shift })
      event.preventDefault()
    }
    return
  }
  const forwardedName =
    event.shift && event.name.length === 1
      ? event.name.toUpperCase()
      : event.name
  bridge.key(forwardedName, {
    ctrl: event.ctrl,
    alt: event.option,
    shift: event.shift,
  })
})

// --- layout budgets -------------------------------------------------------
// Chrome is fixed height, so the body budget only depends on the terminal size
// — never on transient text.
const W = computed(() => Math.max(24, Math.floor(Number(width.value) || 80)))
const H = computed(() => Math.max(8, Math.floor(Number(height.value) || 24)))
const bodyW = computed(() => W.value - 2)
const showRule = computed(() => H.value >= 18)
const bodyH = computed(() => Math.max(3, H.value - (showRule.value ? 4 : 3)))

const blink = ref(true)
useInterval(() => {
  blink.value = !blink.value
}, 530)
useInterval(() => {
  bridge.tickQR()
}, 1500)
watch(
  [width, height],
  () => {
    bridge.resize(Number(width.value), Number(height.value))
    bridge.tickQR()
  },
  { immediate: true },
)

const SCENE_TITLES: Record<string, string> = {
  workspace: '发现',
  filters: '筛选',
  confirm: '确认',
  help: '快捷键',
  'job-detail': '任务详情',
  setup: '连接网关',
  home: '首页',
  search: '搜索',
  results: '搜索结果',
  detail: '选集',
  quality: '画质',
  tmdb: '匹配',
  jobs: '下载任务',
  settings: '设置',
  qr: '扫码登录',
  edit: '编辑',
}

/** The download wizard, shown as a stepper in the header. */
const FLOW = ['detail', 'quality', 'tmdb', 'confirm']

/** Always-available keys, right-aligned in the footer when there is room. */
const GLOBAL_HINTS: Array<[string, string]> = [
  ['F1', '帮助'],
  ['F2', '搜索'],
  ['F3', '任务'],
  ['F4', '设置'],
]

const HINTS: Record<string, Array<[string, string]>> = {
  workspace: [
    ['⏎', '打开'],
    ['←→', '栏目'],
    ['tab', '推荐/榜单'],
    ['1-4', '平台'],
    ['r', '刷新'],
    ['/', '搜索'],
  ],
  filters: [
    ['↑↓', '选择'],
    ['⏎', '应用'],
    ['esc', '取消'],
  ],
  confirm: [
    ['⏎', '加入队列'],
    ['o', '改目录'],
    ['esc', '返回画质'],
  ],
  help: [
    ['↑↓', '滚动'],
    ['esc', '返回'],
  ],
  'job-detail': [
    ['↑↓', '日志'],
    ['esc', '返回'],
  ],
  setup: [
    ['tab', '切换字段'],
    ['⏎', '进入'],
    ['^C', '退出'],
  ],
  home: [
    ['↑↓', '移动'],
    ['⏎', '打开'],
    ['q', '退出'],
  ],
  search: [
    ['⏎', '搜索'],
    ['tab', '切平台'],
    ['esc', '返回'],
  ],
  results: [
    ['⏎', '打开'],
    ['/', '改搜索'],
    ['↑↓', '移动'],
    ['esc', '返回'],
  ],
  detail: [
    ['⏎', '去画质'],
    ['空格', '勾选'],
    ['⇧方向', '连选'],
    ['a/c', '全选/清'],
    ['esc', '返回'],
  ],
  quality: [
    ['⏎', '继续'],
    ['↑↓', '选档'],
    ['←→', '音轨'],
    ['空格', '勾音轨'],
    ['esc', '返回'],
  ],
  tmdb: [
    ['⏎', '采用'],
    ['s', '跳过'],
    ['r', '重试'],
    ['esc', '返回画质'],
  ],
  jobs: [
    ['↑↓', '移动'],
    ['⏎', '日志'],
    ['esc', '返回'],
  ],
  settings: [
    ['↑↓', '移动'],
    ['⏎', '修改'],
    ['esc', '保存返回'],
  ],
  edit: [
    ['⏎', '保存'],
    ['esc', '取消'],
  ],
  qr: [
    ['⏎', '刷新'],
    ['esc', '取消'],
  ],
}

useTitle(() => `GVS · ${SCENE_TITLES[state.value.scene] ?? 'GVS'}`)

/** Window a long list around the cursor, reporting the visible range. */
function sliceList<T>(items: T[] | undefined, cursor: number, room: number) {
  const all = items ?? []
  const total = all.length
  const safeCursor = Number.isFinite(cursor)
    ? Math.max(0, Math.floor(cursor))
    : 0
  const size = Math.max(1, Math.min(Math.max(1, room), total || 1))
  let start = Math.max(0, safeCursor - Math.floor(size / 2))
  if (start + size > total) start = Math.max(0, total - size)
  const view = all.slice(start, start + size)
  return {
    total,
    first: total ? start + 1 : 0,
    last: Math.min(total, start + size),
    rows: view.map((item, offset) => ({ item, index: start + offset })),
  }
}

const episodes = computed(() => state.value.episodes ?? [])
const qualities = computed(() => state.value.qualities ?? [])
const audios = computed(() => state.value.audios ?? [])
const jobs = computed(() => state.value.jobs ?? [])
const settings = computed(() => state.value.settings ?? [])
const providers = computed(() => state.value.providers ?? [])
const homeItems = computed(() => state.value.homeItems ?? [])
/**
 * VIP 徽标要分清三件事：片源要不要 VIP、账号是什么状态、**这次取流到底成不成**。
 * 最后一条来自 `play` 的 `quality_gate`，比会员接口可信——它是真的取到流了。
 */
const vipNotice = computed(() => {
  if (!state.value.detail?.vip) return null
  const probe = state.value.vipProbe
  const acc = state.value.ykAccount
  if (acc?.needsScan) return { text: 'VIP · 需重新扫码', color: c.err }
  if (probe) {
    if (!probe.canPlay) return { text: 'VIP · 该账号不可播', color: c.err }
    if (probe.hasTrial) return { text: 'VIP · 仅试看', color: c.warn }
    return { text: probe.isVip ? 'VIP ✓' : 'VIP · 可播', color: c.ok }
  }
  if (!acc) return { text: 'VIP', color: c.violet }
  if (acc.vipSource === 'api' && !acc.isVip)
    return { text: 'VIP · 账号无权益', color: c.err }
  return {
    text: acc.isVip ? 'VIP ✓' : 'VIP',
    color: acc.isVip ? c.ok : c.violet,
  }
})
/** 画质页右上角：这次取流的实际权益（`play` 给的，不是猜的）。 */
const rightsChip = computed(() => {
  const probe = state.value.vipProbe
  if (probe) {
    const bits = [probe.canPlay ? '可播' : '不可播']
    if (probe.isVip) bits.push('会员✓')
    if (probe.hasTrial) bits.push('仅试看')
    if (probe.note) bits.push(probe.note)
    return {
      text: bits.join(' · '),
      color: !probe.canPlay || probe.hasTrial ? c.warn : c.ok,
    }
  }
  const acc = state.value.ykAccount
  if (acc) {
    if (acc.needsScan) return { text: '登录态不可用', color: c.err }
    if (acc.vipSource === 'api')
      return {
        text: acc.isVip ? '会员✓' : '无会员权益',
        color: acc.isVip ? c.ok : c.warn,
      }
    return {
      text: acc.isVip ? '会员(登录快照)' : '会员未知',
      color: acc.isVip ? c.ok : c.dim,
    }
  }
  return { text: '权益未知', color: c.dim }
})
const accountLine = computed(() => {
  if (state.value.scene !== 'home') return null
  const acc = state.value.ykAccount
  if (!acc) return null
  const tone =
    acc.needsScan || !acc.loggedIn
      ? c.warn
      : acc.vipSource === 'api' && !acc.isVip
        ? c.warn
        : c.ok
  return new StyledText([fg(c.faint)('  优酷  '), fg(tone)(acc.summary)])
})
const detail = computed(() => state.value.detail)
const isMovie = computed(
  () =>
    detail.value?.kind === 'movie' || /电影/.test(detail.value?.category ?? ''),
)
const qualityAction = computed(() => {
  const q = qualities.value[state.value.qualityIndex]
  const n = state.value.pendingCount || 1
  const picked = audios.value.filter((a) => a.selected).map((a) => a.label)
  const audio = !audios.value.length
    ? ''
    : picked.length
      ? picked.slice(0, 2).join('+')
      : '默认音轨'
  return [`下载 ${n} ${isMovie.value ? '部' : '集'}`, q?.label, audio]
    .filter(Boolean)
    .join(' · ')
})
const onAudioTab = computed(
  () => state.value.optionTab === 'audio' && audios.value.length > 0,
)
const audioPicked = computed(
  () => audios.value.filter((a) => a.selected).length,
)
const selectedEpisode = computed(() => episodes.value[state.value.cursor])

const resultView = computed(() =>
  sliceList(state.value.rows, state.value.cursor, bodyH.value - 3),
)
const tmdbView = computed(() =>
  sliceList(
    state.value.tmdbHits,
    state.value.cursor,
    Math.max(1, Math.floor(bodyH.value / 2)),
  ),
)
const qualityView = computed(() =>
  sliceList(qualities.value, state.value.qualityIndex, bodyH.value - 6),
)
const audioView = computed(() =>
  sliceList(audios.value, state.value.audioIndex, bodyH.value - 6),
)
/** Settings grouped by platform prefix; `index` is the setting's cursor index. */
const SETTING_GROUPS = ['优酷', '腾讯', '红果'] as const
const settingRows = computed(() => {
  const out: Array<{ header: string } | { label: string; value: string; index: number }> = []
  let group = ''
  settings.value.forEach((item, index) => {
    const prefix = SETTING_GROUPS.find((g) => item.label.startsWith(g)) ?? ''
    const name = prefix ? prefix : '常规'
    if (name !== group) {
      if (group) out.push({ header: '' })
      out.push({ header: name })
      group = name
    }
    const label = prefix ? item.label.slice(prefix.length).trim() || item.label : item.label
    out.push({ label, value: item.value, index })
  })
  return out
})
const settingView = computed(() => {
  const rows = settingRows.value
  const at = rows.findIndex((row) => 'index' in row && row.index === state.value.cursor)
  return sliceList(rows, Math.max(0, at), bodyH.value)
})
const selectedCount = computed(
  () => episodes.value.filter((ep) => ep.selected).length,
)

const jobStats = computed(() => {
  const list = jobs.value
  return {
    total: list.length,
    done: list.filter((j) => j.status === '完成').length,
    failed: list.filter((j) => j.status === '失败').length,
    queued: list.filter((j) => j.status === '排队').length,
    active: list.filter((j) => !['完成', '失败', '排队'].includes(j.status))
      .length,
  }
})

// --- chrome ---------------------------------------------------------------
const headerProvider = computed(() => {
  const scene = state.value.scene
  const detailP = state.value.detailProvider || ''
  if (
    detailP &&
    (scene === 'detail' ||
      scene === 'quality' ||
      scene === 'confirm' ||
      scene === 'tmdb')
  ) {
    return detailP
  }
  if (scene === 'search' || scene === 'results') {
    return providers.value[state.value.providerIndex] || ''
  }
  return (
    state.value.workspace?.provider ||
    providers.value[state.value.providerIndex] ||
    ''
  )
})

/** `› 红果 › 选集 › 画质 › 匹配 › 确认`, or `› 红果 › 发现` outside the wizard. */
function crumbChunks(cells: number): TextChunk[] {
  const scene = state.value.scene
  const step = FLOW.indexOf(scene)
  const provider = providerName(headerProvider.value)
  const chunks: TextChunk[] = [fg(c.faint)('› '), fg(c.dim)(provider), fg(c.faint)(' › ')]
  let used = displayWidth(`› ${provider} › `)
  const parts =
    step < 0
      ? [[SCENE_TITLES[scene] ?? 'GVS', c.text, true] as const]
      : FLOW.map((id, i) => [SCENE_TITLES[id]!, i === step ? c.accent : i < step ? c.dim : c.faint, i === step] as const)
  parts.forEach(([title, color, strong], i) => {
    const text = `${i ? ' › ' : ''}${title}`
    if (used + displayWidth(text) > cells) return
    chunks.push(strong ? fg(color)(bold(text)) : fg(color)(text))
    used += displayWidth(text)
  })
  chunks.push({ __isChunk: true, text: ' '.repeat(Math.max(0, cells - used)) })
  return chunks
}

const headerLine = computed(() => {
  const right = `${hostLabel(state.value.host)}  ${state.value.tunnelOk ? '● 隧道' : '○ 隧道'}`
  const cols: Col[] = [
    { text: '▌ ', cells: 2, color: c.accent, bold: true },
    { text: 'GVS ', cells: 4, color: c.accent, bold: true },
    { chunks: crumbChunks, grow: true },
  ]
  if (bridge.preview || state.value.simulated)
    cols.push({ text: 'PREVIEW  ', cells: 9, align: 'right', color: c.warn })
  cols.push({
    text: right,
    cells: displayWidth(right),
    align: 'right',
    color: state.value.tunnelOk ? c.ok : c.faint,
  })
  return colsLine(cols, bodyW.value)
})

const busyLabel = computed(() => {
  switch (state.value.scene) {
    case 'search':
    case 'results':
      return '查询中…'
    case 'detail':
      return '取剧集…'
    case 'quality':
      return '取画质…'
    case 'setup':
      return '校验 Key…'
    default:
      return '处理中…'
  }
})

const metaText = computed(() => {
  switch (state.value.scene) {
    case 'results':
      return resultView.value.total
        ? `${resultView.value.first}-${resultView.value.last} / ${resultView.value.total}${state.value.listMore ? '+' : ''}`
        : ''
    case 'tmdb':
      return tmdbView.value.total
        ? `${tmdbView.value.first}-${tmdbView.value.last} / ${tmdbView.value.total}`
        : ''
    case 'detail':
      return isMovie.value
        ? `已选 ${selectedCount.value} / ${episodes.value.length} 个版本`
        : `已选 ${selectedCount.value} / ${episodes.value.length}`
    case 'quality':
      return onAudioTab.value
        ? `音轨 ${state.value.audioIndex + 1} / ${audios.value.length}`
        : qualities.value.length
          ? `档位 ${state.value.qualityIndex + 1} / ${qualities.value.length}`
          : ''
    case 'job-detail':
      return logView.value.total
        ? `${logView.value.first}-${logView.value.last} / ${logView.value.total} 行`
        : ''
    case 'jobs': {
      const s = jobStats.value
      return `${s.done} 完成 · ${s.active} 进行 · ${s.queued} 排队${s.failed ? ` · ${s.failed} 失败` : ''}`
    }
    case 'settings':
      return `${settings.value.length} 项`
    default:
      return ''
  }
})

const statusContent = computed(() => {
  const message = state.value.status
  const tone = state.value.statusKind
  if (!message) return new StyledText([])
  if (tone === 'info') return new StyledText([fg(c.dim)(message)])
  const icon = tone === 'warn' ? '!' : tone === 'err' ? '✖' : '✔'
  return new StyledText([
    fg(toneColor(tone))(bold(icon)),
    fg(toneColor(tone))(` ${message}`),
  ])
})

/** Width reserved on the right half of the status line. */
const statusRightW = computed(() =>
  state.value.busy
    ? displayWidth(busyLabel.value) + 2
    : displayWidth(metaText.value),
)
const statusLeftW = computed(() =>
  Math.max(10, bodyW.value - statusRightW.value - 1),
)

const hints = computed(() => {
  if (state.value.scene === 'quality' && !audios.value.length)
    return [
      ['⏎', '继续'],
      ['↑↓', '选档'],
      ['esc', '返回'],
    ]
  if (state.value.scene === 'detail' && isMovie.value)
    return [
      ['⏎', '下一步'],
      ['空格', '勾选'],
      ['a/c', '全选/清'],
      ['esc', '返回'],
    ]
  if (state.value.scene === 'workspace' && wsSections.value[ws.value?.sectionIndex ?? 0]?.filters?.length)
    return [...HINTS.workspace!.slice(0, -1), ['f', '筛选'], HINTS.workspace!.at(-1)!]
  return HINTS[state.value.scene] ?? []
})
const globalHints = computed(() =>
  state.value.scene === 'setup' ? GLOBAL_HINTS.slice(0, 1) : GLOBAL_HINTS,
)

const ws = computed(() => state.value.workspace)
const wsSections = computed(
  () => ws.value?.sections.filter((s) => s.mode === ws.value?.mode) ?? [],
)
const PLATFORM_ORDER = ['youku', 'tencent', 'hongguo', 'douyin'] as const
function platformBar(current: string, modes?: 'rec' | 'rank') {
  const allowed = new Set(providers.value)
  const cols: Col[] = []
  PLATFORM_ORDER.forEach((id, i) => {
    const label = `${i + 1} ${providerName(id)}`
    cols.push({
      chunks: () => tabChunks(label, id === current, allowed.has(id)),
      cells: tabsWidth([label]),
    })
  })
  cols.push({ text: '', grow: true })
  if (modes)
    cols.push({
      chunks: () => [...tabChunks('推荐', modes === 'rec'), ...tabChunks('榜单', modes === 'rank')],
      cells: tabsWidth(['推荐', '榜单']),
    })
  return colsLine(cols, bodyW.value)
}
/** Visible slice of the section tabs around `index`, with `‹ ›` when clipped. */
function sectionStrip(titles: string[], index: number, width: number): TextChunk[] {
  if (!titles.length || width <= 0) return [fg(c.faint)(' 没有栏目')]
  const cells = (from: number, to: number) =>
    tabsWidth(titles.slice(from, to + 1)) + (from > 0 ? 2 : 0) + (to < titles.length - 1 ? 2 : 0)
  let lo = Math.max(0, Math.min(index, titles.length - 1))
  let hi = lo
  while (lo > 0 || hi < titles.length - 1) {
    const canNext = hi < titles.length - 1 && cells(lo, hi + 1) <= width
    const canPrev = lo > 0 && cells(lo - 1, hi) <= width
    if (canNext && (hi - index <= index - lo || !canPrev)) hi += 1
    else if (canPrev) lo -= 1
    else break
  }
  return [
    ...(lo > 0 ? [fg(c.faint)('‹ ')] : []),
    ...titles.slice(lo, hi + 1).flatMap((title, i) => tabChunks(title, lo + i === index)),
    ...(hi < titles.length - 1 ? [fg(c.faint)(' ›')] : []),
  ]
}
const platformLine = computed(() =>
  platformBar(ws.value?.provider || '', ws.value?.mode === 'rank' ? 'rank' : 'rec'),
)
const searchPlatformLine = computed(() =>
  platformBar(providers.value[state.value.providerIndex] || ''),
)
/** Active filter labels (the view stores option values). */
const filterLabels = computed(() => {
  const active = ws.value?.filters ?? {}
  const defs = wsSections.value[ws.value?.sectionIndex ?? 0]?.filters ?? []
  return Object.entries(active).map(
    ([key, value]) => defs.find((f) => f.key === key)?.options.find((o) => o.value === value)?.label ?? value,
  )
})
const sectionLine = computed(() => {
  const right = [
    ws.value?.loading ? '加载中' : `${ws.value?.rows.length ?? 0} 条`,
    filterLabels.value.join('/'),
  ]
    .filter(Boolean)
    .join(' · ')
  const room = Math.max(8, bodyW.value - displayWidth(right) - 1)
  const strip = sectionStrip(
    wsSections.value.map((s) => s.title),
    ws.value?.sectionIndex ?? 0,
    room,
  )
  return colsLine(
    [
      { chunks: (cells) => [...strip, { __isChunk: true, text: ' '.repeat(Math.max(0, cells - strip.reduce((n, ch) => n + displayWidth(ch.text), 0))) }], grow: true },
      { text: right, cells: displayWidth(right), align: 'right', color: c.faint },
    ],
    bodyW.value,
  )
})
const wide = computed(() => W.value >= 120)
const wsSummaryWidth = computed(() => (wide.value ? 30 : 0))
const wsListWidth = computed(() =>
  Math.max(16, bodyW.value - (wide.value ? wsSummaryWidth.value + 2 : 0)),
)
const wsRows = computed(() => {
  const rows = [...(ws.value?.rows ?? [])]
  if (ws.value?.more) rows.push({ title: '加载更多…', id: '__more__', sub: '' })
  return sliceList(
    rows,
    ws.value?.cursor ?? 0,
    bodyH.value - 3 - (ws.value?.error || ws.value?.notice ? 3 : 0),
  )
})
const wsSelected = computed(() => ws.value?.rows[ws.value.cursor])
const filterRows = computed(
  () =>
    wsSections.value[ws.value?.sectionIndex ?? 0]?.filters?.flatMap((f) =>
      f.options.map((o) => ({ ...o, key: f.key, title: f.title })),
    ) ?? [],
)
const filterView = computed(() =>
  sliceList(filterRows.value, state.value.cursor, bodyH.value - 2),
)
/** `▌ 体裁    ● 全部` — the group title only on its first option. */
function filterLine(item: (typeof filterRows.value)[number], index: number): StyledText {
  const on = index === state.value.cursor
  const first = filterRows.value[index - 1]?.key !== item.key
  const current = ws.value?.filters?.[item.key]
  const active = current ? current === item.value : first
  return colsLine(
    [
      markCol(on),
      { text: first ? item.title : '', cells: 10, color: c.faint, bold: false },
      { text: active ? '● ' : '○ ', cells: 2, color: active ? c.accent : c.faint, bold: false },
      { text: item.label, grow: true, color: on || active ? c.text : c.dim },
    ],
    bodyW.value,
    on,
  )
}
const jobView = computed(() =>
  sliceList(jobs.value, state.value.cursor, bodyH.value - 2),
)
/** Job log below the fixed title/status block. */
const logView = computed(() => {
  const logs = (state.value.jobDetailLines ?? []).slice(2)
  const room = Math.max(1, bodyH.value - 3)
  const start = Math.min(state.value.logOffset ?? 0, Math.max(0, logs.length - room))
  return {
    total: logs.length,
    first: logs.length ? start + 1 : 0,
    last: Math.min(logs.length, start + room),
    lines: logs.slice(start, start + room),
  }
})
const jobDetailTone = computed(() => {
  const line = state.value.jobDetailLines?.[1] ?? ''
  return jobTone(/^(?:状态 )?([^\s·：:]+)/.exec(line)?.[1] ?? '')
})
function wsRow(row: Row, index: number) {
  const on = index === ws.value?.cursor
  const width = wsListWidth.value
  const target =
    row.target?.type === 'search' ? '搜索 →' : row.target?.type === 'channel' ? '频道 →' : ''
  const all = ws.value?.rows ?? []
  const desc = row.desc || (row.tags ?? []).join('·')
  const descW = blurbCells(all, width)
  const cols: Col[] = [
    markCol(on),
    {
      text: row.rank ? String(row.rank).padStart(3, ' ') + '  ' : '',
      cells: all.some((r) => r.rank) ? 5 : 0,
      color: row.rank && row.rank <= 3 ? c.accent : c.faint,
      bold: false,
    },
    { text: row.title, grow: true, color: on ? c.text : c.dim },
  ]
  if (descW) cols.push({ text: '', cells: 2 }, { text: desc, cells: descW, color: c.faint, bold: false })
  if (all.some((r) => r.score))
    cols.push({ text: row.score ? `★${row.score}` : '', cells: 7, align: 'right', color: c.warn, bold: false })
  if (all.some((r) => r.target?.type === 'search' || r.target?.type === 'channel'))
    cols.push({ text: target, cells: 8, align: 'right', color: c.faint, bold: false })
  return colsLine(packTitle(cols, 2, ws.value?.rows, width), width, on)
}
const HELP: Array<[string, Array<[string, string]>]> = [
  [
    '发现页',
    [
      ['1-4', '切平台：1 优酷  2 腾讯  3 红果  4 抖音'],
      ['← →', '换栏目；只有一个栏目时切推荐/榜单'],
      ['tab', '推荐 / 榜单'],
      ['⏎', '打开选中的节目'],
      ['/  f  r', '搜索 · 筛选 · 刷新'],
    ],
  ],
  [
    '下载：选集 › 画质 › 匹配 › 确认（确认页回车才入队）',
    [
      ['空格', '勾选当前集；⇧方向 从当前集连选'],
      ['a  c', '全选 · 清空'],
      ['← →', '画质页切到音轨，空格勾选要封装的音轨'],
      ['⏎  s  r', '匹配页：采用 · 跳过 · 重试'],
    ],
  ],
  [
    '随处可用',
    [
      ['F1-F4', '帮助 · 搜索 · 任务 · 设置'],
      ['esc', '返回上一步（不会入队）'],
      ['^C', '退出'],
      ['^1-4', 'Windows Terminal 会吃掉 Alt+数字，用 Ctrl+数字切平台'],
    ],
  ],
]
const helpLines = computed(() => {
  const out: StyledText[] = []
  HELP.forEach(([title, rows], i) => {
    if (i) out.push(new StyledText([]))
    out.push(ink(c.accent, title, true))
    for (const [keys, desc] of rows)
      out.push(new StyledText([fg(c.text)(`  ${column(keys, 10)}`), fg(c.dim)(desc)]))
  })
  return out
})

// --- detail screen --------------------------------------------------------
const gridRows = computed(() =>
  Math.max(1, bodyH.value - (state.value.detail?.desc ? 6 : 4)),
)

/** Synopsis as at most two indented lines; the second one ends in `..` when cut. */
const descLines = computed(() => {
  const desc = (state.value.detail?.desc ?? '').replace(/\s+/g, ' ').trim()
  if (!desc) return []
  const room = Math.max(10, bodyW.value - 2)
  const lines = wrapLines(desc, room)
  if (lines.length > 2) lines[1] = clip(`${lines[1]}${lines[2]}`, room)
  return lines.slice(0, 2).map((line) => `  ${line}`)
})

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** `奇幻短剧 · 奇幻/古代/乡村 · 评分 8.0 · 总时长 1:21:50` */
const detailFacts = computed(() => {
  const d = state.value.detail
  if (!d) return ''
  const parts: string[] = []
  if (d.category) parts.push(d.category)
  if (d.tags?.length) parts.push(d.tags.join('/'))
  if (d.score) parts.push(`评分 ${d.score}`)
  const firstLen = episodes.value[0]?.duration ?? 0
  if (d.episodes <= 1 && d.duration > 0) parts.push(`时长 ${clock(d.duration)}`)
  else if (firstLen > 0) parts.push(`每集约 ${clock(firstLen)}`)
  if (d.drm) parts.push(d.drm)
  return parts.length ? clip(`  ${parts.join('  ·  ')}`, bodyW.value) : ''
})

const episodeLine = computed(() => {
  const ep = selectedEpisode.value
  if (!ep) return ''
  const bits: string[] = isMovie.value
    ? [ep.title || '正片']
    : [`E${String(ep.number).padStart(2, '0')}`]
  const len = clock(ep.duration ?? 0)
  if (len) bits.push(len)
  const title = isMovie.value ? '' : (ep.title || '').trim()
  return new StyledText([
    fg(c.accent)(bold(`  ${bits.join(' · ')}`)),
    fg(c.faint)(
      title ? `  ${clip(title, Math.max(10, bodyW.value - 24))}` : '',
    ),
  ])
})

const detailCountLabel = computed(() => {
  if (isMovie.value)
    return episodes.value.length > 1
      ? `${episodes.value.length} 个版本`
      : '电影'
  return `${episodes.value.length} 集`
})

function editionLine(ep: Episode, here: boolean) {
  const mark = ep.selected ? '✓' : '□'
  return colsLine(
    [
      {
        text: `${mark}  ${ep.title || '正片'}`,
        grow: true,
        color: here ? c.text : ep.selected ? c.ok : c.faint,
        bold: here,
      },
      {
        text: clock(ep.duration ?? 0),
        cells: 8,
        align: 'right',
        color: c.faint,
      },
    ],
    bodyW.value,
  )
}

// Cards are sized from the terminal, never from a fixed number, so nothing
// overflows on a narrow window.
const setupCardW = computed(() => Math.max(44, Math.min(72, bodyW.value - 2)))
const setupFieldBoxW = computed(() => setupCardW.value - 6)
const setupFieldW = computed(() => setupFieldBoxW.value - 3)
const editBoxW = computed(() => Math.max(30, Math.min(72, bodyW.value - 2)))
const editW = computed(() => editBoxW.value - 4)

/** Never crop a QR. Quiet-zone rows are spaces — keep them. Hide rather than slice. */
const qrLines = computed(() => {
  const raw = state.value.qrAscii || ''
  if (!raw) return [] as string[]
  return raw.replace(/\n$/, '').split('\n')
})
const qrOverflow = computed(() => {
  const lines = qrLines.value
  if (!lines.length) return false
  const room = Math.max(0, bodyH.value - 6)
  const widest = lines.reduce(
    (max, line) => Math.max(max, displayWidth(line)),
    0,
  )
  return lines.length > room || widest > bodyW.value
})
const qrBlock = computed(() => {
  if (qrOverflow.value) return ''
  const lines = qrLines.value
  const widest = lines.reduce(
    (max, line) => Math.max(max, displayWidth(line)),
    0,
  )
  const indent = ' '.repeat(Math.max(0, Math.floor((bodyW.value - widest) / 2)))
  return lines.map((line) => indent + line).join('\n')
})
const qrPngHint = computed(() => {
  const paths = state.value.qrPngPaths ?? []
  if (!paths.length) return ''
  return `扫码图片（绝对路径）\n${paths.join('\n')}`
})

// --- row builders ---------------------------------------------------------
const labelCells = computed(() =>
  Math.min(14, Math.max(8, Math.floor(bodyW.value * 0.2))),
)

function qualityTable(header: boolean, row?: Quality, selected = false): StyledText {
  const width = bodyW.value
  const showRes = width >= 64
  const showDrm = width >= 72
  const showCaption = qualities.value.some((q) => qualityCaptionText(q.caption))
  const showHdr = qualities.value.some((q) => qualityHdrText(q.hdr))
  const showFps = qualities.value.some((q) => qualityFpsText(q.fps))
  const tone = selected ? c.text : c.dim
  const name =
    !row
      ? '档位'
      : row.group === 'source'
        ? row.label || '原画'
        : row.group === 'encode'
          ? `⚡${row.label || (row.stream || row.title || '').split('|')[0] || '转码'}`
          : row.label || row.title || '视频流'
  const drm = !row?.drm ? '—' : 'DRM'
  // Size the name column to the longest label, and let a trailing spacer take
  // the slack, so short tables do not stretch across a wide terminal.
  const nameCells = Math.min(
    Math.max(10, Math.floor(width * 0.4)),
    qualities.value.reduce((n, q) => Math.max(n, displayWidth(q.label || q.title || '') + 3), 8),
  )
  const cols: Col[] = [
    header ? { text: '  ', cells: 2 } : markCol(selected),
    {
      text: header ? '档位' : name,
      cells: nameCells,
      color: header ? c.dim : c.text,
      bold: selected,
    },
  ]
  const field = (title: string, value: string, cells: number, align?: 'left' | 'right') => {
    cols.push({ text: '', cells: 2 })
    cols.push({
      text: header ? title : value,
      cells,
      align,
      color: header ? c.dim : tone,
    })
  }
  // Keep these labels inside the cell. Row truncate used to plant an ellipsis
  // immediately after the short HDR word.
  const captionText = (q?: Quality) => (q ? qualityCaptionText(q.caption) || '-' : '')
  const hdrText = (q?: Quality) => (q ? qualityHdrText(q.hdr) || '-' : '')
  if (showCaption) field('字幕', header ? '字幕' : captionText(row), 10)
  if (showHdr) field('HDR', header ? 'HDR' : hdrText(row), 8)
  if (showRes) field('分辨率', row ? qualityResolution(row.width, row.height) : '', 12)
  if (showFps) field('fps', row ? qualityFpsText(row.fps) || '—' : '', 6)
  field('编码', row ? row.encodeTag || row.codec || '—' : '', width >= 100 ? 10 : 8)
  field('体积', row ? (row.size > 0 ? human(row.size) : '—') : '', 10, 'right')
  if (showDrm) field('DRM', row ? drm : '', 4)
  cols.push({ text: '', grow: true })
  return colsLine(cols, width, selected && !header)
}

function qualityHeader(): StyledText {
  return qualityTable(true)
}

function qualityLine(row: Quality, selected: boolean): StyledText {
  return qualityTable(false, row, selected)
}

const AUDIO_COLS = { label: 18, lang: 10, codec: 12 }

function audioHeader(): StyledText {
  return colsLine(
    [
      { text: ' '.repeat(4), cells: 4 },
      { text: '音轨', cells: AUDIO_COLS.label, color: c.dim },
      { text: '', cells: 2 },
      { text: '语言', cells: AUDIO_COLS.lang, color: c.dim },
      { text: '', cells: 2 },
      { text: '编码', cells: AUDIO_COLS.codec, color: c.dim },
    ],
    bodyW.value,
  )
}

function audioLine(row: Audio, selected: boolean): StyledText {
  const muxDefault =
    (audios.value.find((a) => a.selected) ??
      audios.value.find((a) => a.isDefault)) === row
  return colsLine(
    [
      markCol(selected),
      {
        text: row.selected ? '✓ ' : '□ ',
        cells: 2,
        color: row.selected ? c.ok : c.faint,
      },
      {
        text: row.label || row.id,
        cells: AUDIO_COLS.label,
        color: selected ? c.text : c.dim,
        bold: selected,
      },
      { text: '', cells: 2 },
      { text: row.lang || '—', cells: AUDIO_COLS.lang, color: c.dim },
      { text: '', cells: 2 },
      { text: row.codec || '', cells: AUDIO_COLS.codec, color: c.dim },
      {
        text: [muxDefault ? '封装默认' : '', row.isDefault ? '平台默认' : '']
          .filter(Boolean)
          .join(' · '),
        grow: true,
        align: 'right',
        color: muxDefault ? c.ok : c.faint,
      },
    ],
    bodyW.value,
    selected,
  )
}

/**
 * Pack a list row to the left: the title column is only as wide as the widest
 * title in the list, so the blurb sits next to the titles instead of floating
 * at the far edge; a trailing spacer takes the slack.
 */
function packTitle(cols: Col[], titleAt: number, rows: Row[] | undefined, width: number): Col[] {
  const widest = (rows ?? []).reduce((n, r) => Math.max(n, displayWidth(r.title)), 0)
  const rest = cols.reduce((n, col, i) => n + (i === titleAt ? 0 : (col.cells ?? 0)), 0)
  cols[titleAt] = { ...cols[titleAt]!, grow: false, cells: Math.max(6, Math.min(widest + 2, width - rest)) }
  return [...cols, { text: '', grow: true }]
}

/** One blurb column width per list, so the blurbs line up across rows. */
function blurbCells(rows: Row[] | undefined, width: number): number {
  const widest = (rows ?? []).reduce((n, r) => Math.max(n, displayWidth(r.desc || (r.tags ?? []).join('·'))), 0)
  return Math.min(widest, Math.floor(width * 0.4))
}

/** `▌ 斗破苍穹年番              萧炎智斗蛇人族   ★9.1  优酷` */
function resultLine(row: Row, selected: boolean, width: number): StyledText {
  const meta = row.desc || (row.tags ?? []).join('·')
  const metaW = blurbCells(state.value.rows, width)
  // Platform ids are long and only matter when two titles collide; show them
  // when there is room to spare.
  const id = width >= 118 && row.id ? `  ${row.id}` : ''
  const cols: Col[] = [
    markCol(selected),
    { text: row.title, grow: true, color: selected ? c.text : c.dim },
  ]
  if (metaW) cols.push({ text: '', cells: 2 }, { text: meta, cells: metaW, color: c.faint, bold: false })
  cols.push({ text: row.score ? `★${row.score}` : '', cells: 7, align: 'right', color: c.warn, bold: false })
  cols.push({ text: `  ${providerName(row.sub)}`, cells: 6, color: c.faint, bold: false })
  if (id) cols.push({ text: id, cells: displayWidth(id), color: c.line, bold: false })
  return colsLine(packTitle(cols, 1, state.value.rows, width), width, selected)
}

const jobCells = computed(() => ({
  title: Math.min(34, Math.max(14, Math.floor(bodyW.value * 0.34))),
  bar: Math.min(18, Math.max(8, Math.floor(bodyW.value * 0.16))),
}))

function jobHeader(): StyledText {
  const { title, bar } = jobCells.value
  return colsLine(
    [
      { text: '', cells: 4 },
      { text: '任务', cells: title, color: c.faint },
      { text: '', cells: 1 },
      { text: '进度', cells: bar + 5, color: c.faint },
      { text: '', cells: 2 },
      { text: '状态', grow: true, color: c.faint },
    ],
    bodyW.value,
  )
}

function jobLine(job: Job, selected: boolean): StyledText {
  const tone = jobTone(job.status)
  const pct = Math.max(0, Math.min(100, Math.round((job.pct ?? 0) * 100)))
  const { title: titleCells, bar: barCells } = jobCells.value
  const failed = job.status === '失败'
  const degraded = job.status === '完成' && !!job.note
  const trailing = failed
    ? job.err || '失败'
    : job.status === '完成'
      ? degraded ? `降级：${job.note} · ${job.log}` : job.log || '完成'
      : job.log || job.status
  const cols: Col[] = [
    markCol(selected),
    { text: `${tone.icon} `, cells: 2, color: degraded ? c.warn : tone.color, bold: false },
    { text: job.title, cells: titleCells, color: failed ? c.dim : c.text },
    { text: ' ', cells: 1 },
    {
      chunks: (cells) => barChunks(pct / 100, cells, failed ? c.err : c.accent),
      cells: barCells,
    },
    { text: ' ', cells: 1 },
    {
      text: `${pct}%`,
      cells: 4,
      align: 'right',
      color: pct >= 100 ? c.ok : c.dim,
      bold: false,
    },
    { text: '  ', cells: 2 },
    { text: trailing, grow: true, color: failed ? c.err : degraded ? c.warn : c.faint, bold: false },
  ]
  return colsLine(cols, bodyW.value, selected)
}
</script>

<template>
  <Box :width="W" :height="H" flexDirection="column" :backgroundColor="c.bg">
    <!-- header -->
    <Box
      :width="W"
      :height="1"
      flexDirection="row"
      :backgroundColor="c.panel"
      :paddingLeft="1"
      :paddingRight="1"
    >
      <Text
        :content="headerLine"
        :width="bodyW"
        :height="1"
        wrapMode="none"
        :truncate="true"
      />
    </Box>
    <Text
      v-if="showRule"
      :content="'─'.repeat(W)"
      :width="W"
      :height="1"
      :fg="c.line"
    />

    <!-- body -->
    <Box
      :flexGrow="1"
      flexDirection="column"
      :width="W"
      :paddingLeft="1"
      :paddingRight="1"
    >
      <Box v-if="W < 60 || H < 18" flexDirection="column"
        ><Text
          :content="ink(c.warn, '终端太小，请扩大到至少 60×18')"
          :width="bodyW"
          :height="1"
          :truncate="true"
      /></Box>
      <!-- setup -->
      <Box
        v-else-if="state.scene === 'setup'"
        :flexGrow="1"
        flexDirection="row"
        justifyContent="center"
        alignItems="center"
      >
        <Box
          :width="setupCardW"
          flexDirection="column"
          :border="true"
          borderStyle="rounded"
          :borderColor="c.line"
          :backgroundColor="c.panel"
          :paddingLeft="2"
          :paddingRight="2"
          :paddingTop="1"
          :paddingBottom="1"
        >
          <Text :content="ink(c.accent, '▌ GVS', true)" :height="1" />
          <Text
            :content="ink(c.dim, '填入管理台签发的网关地址与 API Key')"
            :height="1"
          />
          <Text
            :content="'网关地址'"
            :height="1"
            :marginTop="1"
            :fg="state.hostFocused ? c.accent : c.dim"
          />
          <Box
            :width="setupFieldBoxW"
            :border="true"
            borderStyle="single"
            :borderColor="state.hostFocused ? c.accent : c.line"
            :backgroundColor="c.sunken"
            :paddingLeft="1"
          >
            <Input
              ref="hostField"
              v-model="host"
              placeholder="http://127.0.0.1:8080"
              autofocus
              :backgroundColor="c.sunken"
              :focusedBackgroundColor="c.sunken"
              :textColor="c.text"
              :placeholderColor="c.faint"
              :width="setupFieldW"
            />
          </Box>
          <Text
            :content="'API Key'"
            :height="1"
            :marginTop="1"
            :fg="state.keyFocused ? c.accent : c.dim"
          />
          <Box
            :width="setupFieldBoxW"
            :border="true"
            borderStyle="single"
            :borderColor="state.keyFocused ? c.accent : c.line"
            :backgroundColor="c.sunken"
            :paddingLeft="1"
          >
            <Input
              ref="keyField"
              v-model="key"
              placeholder="sk_live_..."
              :backgroundColor="c.sunken"
              :focusedBackgroundColor="c.sunken"
              :textColor="c.text"
              :placeholderColor="c.faint"
              :width="setupFieldW"
            />
          </Box>
          <Text
            :content="ink(c.faint, 'tab 切换字段 · ⏎ 保存并进入')"
            :height="1"
            :marginTop="1"
          />
        </Box>
      </Box>

      <!-- platform workspace -->
      <Box
        v-else-if="state.scene === 'workspace' || state.scene === 'home'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="platformLine"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
        />
        <Text
          :content="sectionLine"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
        />
        <Box flexDirection="row" :height="Math.max(2, bodyH - 3)">
          <Box flexDirection="column" :width="wsListWidth">
            <Text
              v-if="ws?.error"
              :content="
                new StyledText([
                  fg(c.err)(bold('✖ ')),
                  fg(c.err)(ws.error),
                  fg(c.faint)(/重试/.test(ws.error) ? '' : '  ·  按 r 重试'),
                ])
              "
              :width="wsListWidth"
              :height="2"
              :marginTop="1"
            />
            <Text
              v-else-if="ws?.notice"
              :content="ink(c.warn, '! ' + ws.notice)"
              :width="wsListWidth"
              :height="2"
              :marginTop="1"
            />
            <Text
              v-if="!wsRows.total && !ws?.loading && !ws?.notice && !ws?.error"
              :content="
                ink(
                  c.dim,
                  providers.length
                    ? '这个栏目暂无内容  ·  按 / 搜索，或 r 刷新'
                    : '当前 Key 没有可浏览的平台  ·  按 F4 检查设置',
                )
              "
              :width="wsListWidth"
              :height="2"
              :marginTop="1"
            />
            <Text
              v-if="ws?.loading && !wsRows.total"
              :content="ink(c.faint, '正在读取平台栏目与内容…')"
              :height="1"
              :marginTop="1"
            />
            <Text
              v-for="entry in wsRows.rows"
              :key="entry.index"
              :content="wsRow(entry.item, entry.index)"
              :width="wsListWidth"
              :height="1"
              wrapMode="none"
              :truncate="true"
              :bg="entry.index === ws?.cursor ? c.sel : undefined"
            />
          </Box>
          <Box
            v-if="wide"
            :width="wsSummaryWidth + 2"
            :paddingLeft="1"
            :border="['left']"
            :borderColor="c.line"
            flexDirection="column"
            ><Text
              :content="ink(c.text, wsSelected?.title || '未选中', true)"
              :width="wsSummaryWidth"
              :height="displayWidth(wsSelected?.title || '') > wsSummaryWidth ? 2 : 1"
              wrapMode="char" /><Text
              v-if="wsSelected?.score"
              :content="ink(c.warn, `★ ${wsSelected.score}`)"
              :height="1"
              :marginTop="1" /><Text
              v-if="wsSelected?.desc || wsSelected?.tags?.length"
              :content="ink(c.dim, [wsSelected?.desc, (wsSelected?.tags ?? []).join(' · ')].filter(Boolean).join('\n\n'))"
              :width="wsSummaryWidth"
              :marginTop="1"
              wrapMode="char" /><Text
              v-if="wsSelected"
              :content="ink(c.faint, wsSelected.target?.type === 'search' ? '⏎ 搜索同名候选' : '⏎ 进入详情')"
              :height="1"
              :marginTop="1"
          /></Box>
        </Box>
        <Text
          :content="
            ink(
              c.faint,
              `${ws?.compatibility ? '旧网关兼容 · ' : ''}${ws?.source || '公开内容'}`,
            )
          "
          :height="1"
          :width="bodyW"
          :truncate="true"
        />
      </Box>
      <Box v-else-if="state.scene === 'filters'" flexDirection="column"
        ><Text
          :content="
            new StyledText([
              fg(c.text)(bold('筛选 ')),
              fg(c.dim)(wsSections[ws?.sectionIndex ?? 0]?.title ?? ''),
            ])
          "
          :height="1"
          :marginBottom="1" /><Text
          v-for="entry in filterView.rows"
          :key="entry.item.key + entry.item.value"
          :content="filterLine(entry.item, entry.index)"
          :bg="entry.index === state.cursor ? c.sel : undefined"
          :height="1"
          :width="bodyW"
          :truncate="true"
      /></Box>
      <Box v-else-if="state.scene === 'help'" flexDirection="column"
        ><Text
          v-for="(line, index) in helpLines.slice(
            Math.min(state.cursor, Math.max(0, helpLines.length - bodyH)),
            Math.min(state.cursor, Math.max(0, helpLines.length - bodyH)) +
              bodyH,
          )"
          :key="index"
          :content="line"
          :height="1"
          :width="bodyW"
          :truncate="true"
      /></Box>
      <Box
        v-else-if="state.scene === 'confirm'"
        flexDirection="column"
        :width="bodyW"
        ><Text
          :content="
            new StyledText([
              fg(c.accent)(bold('确认下载  ')),
              fg(c.text)(bold(state.confirmation?.title || '')),
              fg(c.faint)('   回车后才会创建任务'),
            ])
          "
          :height="1"
          :width="bodyW"
          :truncate="true" /><Text
          :content="ink(c.line, '─'.repeat(bodyW))"
          :height="1"
          :marginTop="H < 24 ? 0 : 1"
          :width="bodyW" /><Text
          v-for="(value, label) in {
            集数: state.confirmation?.episodes,
            画质: state.confirmation?.quality,
            音轨: state.confirmation?.audio,
            目录: state.confirmation?.directory,
            文件名: state.confirmation?.name,
          }"
          :key="label"
          :content="kvLine(String(label), value || '—', bodyW, false, label === '目录' || label === '文件名' ? c.text : c.dim, 10)"
          :height="1"
          :marginTop="H < 24 ? 0 : 1"
          :width="bodyW"
          :truncate="true" /><Text
          :content="ink(c.line, '─'.repeat(bodyW))"
          :height="1"
          :marginTop="H < 24 ? 0 : 1"
          :width="bodyW" /><Text
          :content="
            new StyledText([
              bg(c.accent)(fg(c.bg)(bold(' ⏎ 加入下载队列 '))),
            ])
          "
          :height="1"
          :marginTop="1"
          :width="bodyW"
          :truncate="true"
      /></Box>
      <Box v-else-if="state.scene === 'job-detail'" flexDirection="column"
        ><Text
          :content="ink(c.text, state.jobDetailLines?.[0] ?? '', true)"
          :height="1"
          :width="bodyW"
          :truncate="true" /><Text
          :content="
            new StyledText([
              fg(jobDetailTone.color)(`${jobDetailTone.icon} `),
              fg(jobDetailTone.color)(state.jobDetailLines?.[1] ?? ''),
            ])
          "
          :height="1"
          :width="bodyW"
          :truncate="true" /><Text
          :content="ink(c.line, '─'.repeat(bodyW))"
          :height="1"
          :width="bodyW" /><Text
          v-for="(line, index) in logView.lines"
          :key="index"
          :content="ink(c.dim, line)"
          :height="1"
          :width="bodyW"
          :truncate="true"
      /></Box>

      <!-- search -->
      <Box
        v-else-if="state.scene === 'search'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="searchPlatformLine"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
        />
        <Text
          :content="
            new StyledText([
              fg(c.text)(bold('搜索片名')),
              fg(c.faint)(`，在 ${providerName(providers[state.providerIndex] || '')} 中查找；也可以直接粘贴链接`),
            ])
          "
          :height="1"
          :marginTop="1"
          :width="bodyW"
          :truncate="true"
        />
        <Box
          flexDirection="row"
          :width="bodyW"
          :height="3"
          :marginTop="1"
          :border="true"
          borderStyle="rounded"
          :borderColor="c.accent"
          :backgroundColor="c.sunken"
          :paddingLeft="1"
          :paddingRight="1"
        >
          <Input
            ref="searchField"
            v-model="query"
            autofocus
            placeholder="搜片名，或粘贴优酷/腾讯/抖音链接"
            :backgroundColor="c.sunken"
            :focusedBackgroundColor="c.sunken"
            :textColor="c.text"
            :placeholderColor="c.faint"
            :width="bodyW - 4"
          />
        </Box>
        <Text
          :content="ink(c.faint, '支持的链接')"
          :height="1"
          :marginTop="1"
          :width="bodyW"
          :truncate="true"
        />
        <Text
          :content="ink(c.dim, '  优酷  https://v.youku.com/v_show/id_xxx.html')"
          :height="1"
          :width="bodyW"
          :truncate="true"
        />
        <Text
          :content="ink(c.dim, '  腾讯  https://v.qq.com/x/cover/xxx.html')"
          :height="1"
          :width="bodyW"
          :truncate="true"
        />
        <Text
          :content="ink(c.dim, '  抖音  分享口令整段粘贴即可')"
          :height="1"
          :width="bodyW"
          :truncate="true"
        />
      </Box>

      <!-- results -->
      <Box
        v-else-if="state.scene === 'results'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="
            new StyledText([
              fg(c.text)(bold(state.query ? `「${clip(state.query, 30)}」` : '搜索结果')),
              fg(c.faint)(`  ${providerName(providers[state.providerIndex] || '')} · ${resultView.total} 条${state.listMore ? '+' : ''}`),
            ])
          "
          :height="1"
          :width="bodyW"
          :truncate="true"
          :marginBottom="1"
        />
        <Text
          v-if="!resultView.total"
          :content="ink(c.dim, '没有结果  ·  按 / 换个关键词，或在搜索页用 tab 换平台')"
          :height="1"
        />
        <Text
          v-for="entry in resultView.rows"
          :key="`${entry.item.sub}-${entry.item.id}-${entry.index}`"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
          :bg="entry.index === state.cursor ? c.sel : undefined"
          :content="resultLine(entry.item, entry.index === state.cursor, bodyW)"
        />
        <Text
          v-if="state.listMore"
          :content="
            pickLine(
              '加载更多…',
              '',
              bodyW,
              state.cursor === (state.rows?.length ?? 0),
            )
          "
          :height="1"
          :width="bodyW"
        />
      </Box>

      <!-- detail -->
      <Box
        v-else-if="state.scene === 'detail'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="
            colsLine(
              [
                {
                  text:
                    state.detail?.title ||
                    state.detailTitle ||
                    (isMovie ? '电影' : '剧集'),
                  grow: true,
                  color: c.text,
                  bold: true,
                },
                {
                  text: state.detail?.vip ? 'VIP' : '',
                  cells: 4,
                  align: 'right',
                  color: c.violet,
                },
                {
                  text: detailCountLabel,
                  cells: displayWidth(detailCountLabel),
                  align: 'right',
                  color: c.faint,
                },
              ],
              bodyW,
            )
          "
          :width="bodyW"
          :height="1"
        />
        <Text
          v-if="detailFacts"
          :content="detailFacts"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
        />
        <Text
          v-for="(line, i) in descLines"
          :key="`desc-${i}`"
          :content="ink(c.faint, line)"
          :width="bodyW"
          :height="1"
          wrapMode="none"
        />
        <Text
          v-if="selectedEpisode && !isMovie"
          :content="episodeLine"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
          :marginTop="1"
        />
        <Text
          v-if="!episodes.length"
          :content="ink(c.faint, '这部没有返回正片，esc 返回换一部')"
          :height="1"
        />
        <Box
          v-else-if="isMovie"
          flexDirection="column"
          :width="bodyW"
          :marginTop="1"
        >
          <Text
            v-for="(ep, i) in episodes"
            :key="ep.vid || i"
            :width="bodyW"
            :height="1"
            wrapMode="none"
            :truncate="true"
            :bg="i === state.cursor ? c.sel : undefined"
            :content="editionLine(ep, i === state.cursor)"
          />
        </Box>
        <EpisodeGrid
          v-else
          :episodes="episodes"
          :cursor="state.cursor"
          :width="bodyW"
          :rows="gridRows"
        />
      </Box>

      <!-- quality + audio -->
      <Box
        v-else-if="state.scene === 'quality'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="
            colsLine(
              [
                {
                  text: qualityAction,
                  grow: true,
                  color: c.accent,
                },
                {
                  text: state.detail?.vip
                    ? (vipNotice?.text ?? 'VIP')
                    : rightsChip.text,
                  cells: 20,
                  align: 'right',
                  color: state.detail?.vip
                    ? (vipNotice?.color ?? c.violet)
                    : rightsChip.color,
                },
              ],
              bodyW,
            )
          "
          :height="1"
        />
        <Text
          :height="1"
          :marginTop="1"
          :width="bodyW"
          :content="
            new StyledText([
              ...tabChunks(`画质 ${qualities.length} 档`, !onAudioTab),
              ...(audios.length
                ? tabChunks(
                    audios.every((a) => a.embedded)
                      ? '内嵌音轨 · 随画质切换'
                      : `音轨 ${audios.length} 条 · 已选 ${audioPicked}`,
                    onAudioTab,
                  )
                : []),
              fg(c.faint)(audios.length ? '   ←→ 切换' : ''),
            ])
          "
        />
        <Text
          :height="1"
          :content="onAudioTab ? audioHeader() : qualityHeader()"
          :width="bodyW"
          wrapMode="none"
        />
        <Text
          :height="1"
          :content="ink(c.line, '─'.repeat(bodyW))"
          :width="bodyW"
          wrapMode="none"
        />
        <Text v-if="!qualities.length && !state.busy" :content="ink(c.err,state.status || '没有可用画质，请重试或返回')" :width="bodyW" :height="Math.max(2,bodyH-5)" />
        <Text
          v-for="entry in onAudioTab ? audioView.rows : qualityView.rows"
          :key="`${onAudioTab ? 'a' : 'q'}-${entry.index}`"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="onAudioTab"
          :bg="
            entry.index === (onAudioTab ? state.audioIndex : state.qualityIndex)
              ? c.sel
              : undefined
          "
          :content="
            onAudioTab
              ? audioLine(entry.item as Audio, entry.index === state.audioIndex)
              : qualityLine(
                  entry.item as Quality,
                  entry.index === state.qualityIndex,
                )
          "
        />
      </Box>

      <!-- tmdb -->
      <Box
        v-else-if="state.scene === 'tmdb'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="
            new StyledText([
              fg(c.text)(bold(`「${clip(state.detail?.title || state.detailTitle || '', 30)}」`)),
              fg(c.faint)('  选一个 TMDB 条目，用于文件命名和刮削'),
            ])
          "
          :height="1"
          :width="bodyW"
          :truncate="true"
          :marginBottom="1"
        />
        <Text
          v-if="!tmdbView.total"
          :content="ink(c.dim, '没有匹配的候选  ·  s 跳过匹配，r 重试')"
          :height="2"
          :width="bodyW"
        />
        <Box
          v-for="entry in tmdbView.rows"
          :key="entry.item.id"
          flexDirection="column"
          :width="bodyW"
        >
          <Text
            :width="bodyW"
            :height="1"
            wrapMode="none"
            :truncate="true"
            :bg="entry.index === state.cursor ? c.sel : undefined"
            :content="
              pickLine(
                `${entry.item.name || entry.item.title}${entry.item.year ? ` (${entry.item.year})` : ''}`,
                `tmdb-${entry.item.id}`,
                bodyW,
                entry.index === state.cursor,
              )
            "
          />
          <Text
            v-if="entry.item.overview"
            :content="
              ink(
                entry.index === state.cursor ? c.dim : c.faint,
                `  ${column(entry.item.overview, Math.max(8, bodyW - 2))}`,
              )
            "
            :bg="entry.index === state.cursor ? c.sel : undefined"
            :width="bodyW"
            :height="1"
            wrapMode="none"
            :truncate="true"
          />
        </Box>
      </Box>

      <!-- jobs -->
      <Box
        v-else-if="state.scene === 'jobs'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          v-if="!jobs.length"
          :content="ink(c.dim, '还没有下载任务  ·  按 F2 搜索，或 esc 回发现页选片')"
          :height="1"
          :marginTop="1"
        />
        <template v-else>
          <Text :content="jobHeader()" :width="bodyW" :height="1" wrapMode="none" />
          <Text :content="ink(c.line, '─'.repeat(bodyW))" :width="bodyW" :height="1" />
        </template>
        <Text
          v-for="entry in jobView.rows"
          :key="entry.item.id"
          :content="jobLine(entry.item, entry.index === state.cursor)"
          :bg="entry.index === state.cursor ? c.sel : undefined"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
        />
      </Box>

      <!-- settings -->
      <Box
        v-else-if="state.scene === 'settings'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          v-for="entry in settingView.rows"
          :key="'header' in entry.item ? `h-${entry.index}` : `s-${entry.item.index}`"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
          :bg="'index' in entry.item && entry.item.index === state.cursor ? c.sel : undefined"
          :content="
            'header' in entry.item
              ? ink(c.accent, entry.item.header, true)
              : kvLine(
                  entry.item.label,
                  entry.item.value,
                  bodyW,
                  entry.item.index === state.cursor,
                  valueColor(entry.item.value),
                )
          "
        />
      </Box>

      <!-- edit -->
      <Box
        v-else-if="state.scene === 'edit'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="ink(c.text, state.editField || '编辑', true)"
          :height="1"
        />
        <Box
          :width="editBoxW"
          :height="3"
          :marginTop="1"
          :border="true"
          borderStyle="rounded"
          :borderColor="c.accent"
          :backgroundColor="c.sunken"
          :paddingLeft="1"
          :paddingRight="1"
        >
          <Input
            ref="editField"
            v-model="edit"
            autofocus
            :backgroundColor="c.sunken"
            :focusedBackgroundColor="c.sunken"
            :textColor="c.text"
            :placeholderColor="c.faint"
            :width="editW"
          />
        </Box>
      </Box>

      <!-- qr -->
      <Box
        v-else-if="state.scene === 'qr'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          :content="ink(c.dim, state.qrHint || '用优酷 App 扫码登录，登录态会写进本机')"
          :height="1"
        />
        <Box :height="1" />
        <Text
          v-if="qrOverflow"
          :content="
            ink(c.warn, '窗口太小画不下完整二维码，请打开下面路径的 PNG')
          "
        />
        <Text
          v-else-if="qrBlock"
          :content="qrBlock"
          :fg="c.text"
          wrapMode="none"
        />
        <Text
          v-else
          :content="ink(c.ok, '二维码图片已生成，并已尝试用系统图片查看器打开')"
          :height="1"
        />
        <Text
          v-if="qrPngHint"
          :content="ink(c.warn, qrPngHint)"
          wrapMode="wrap"
          :marginTop="1"
        />
        <Text
          :content="
            ink(
              c.faint,
              '扫完按回车继续轮询（Win10 1809 控制台会把定时器卡住）',
            )
          "
          :height="1"
          :marginTop="1"
        />
      </Box>
    </Box>

    <!-- status -->
    <Box
      :width="W"
      :height="1"
      flexDirection="row"
      :paddingLeft="1"
      :paddingRight="1"
    >
      <Text
        :content="statusContent"
        :width="statusLeftW"
        :height="1"
        wrapMode="none"
        :truncate="true"
      />
      <Spinner v-if="state.busy" :label="busyLabel" />
      <Text
        v-else
        :content="ink(c.faint, padStart(metaText, statusRightW))"
        :width="statusRightW"
        :height="1"
      />
    </Box>

    <!-- footer -->
    <Box
      :width="W"
      :height="1"
      flexDirection="row"
      :backgroundColor="c.panel"
      :paddingLeft="1"
      :paddingRight="1"
    >
      <KeyHints :hints="hints" :extra="globalHints" :width="bodyW" />
    </Box>
  </Box>
</template>
