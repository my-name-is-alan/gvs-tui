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
  bold,
  fg,
  onKeyDown,
  useExit,
  useInterval,
  useTerminalSize,
  useTitle,
} from 'vue-termui'
import { Bridge, type Snapshot } from './bridge'
import EpisodeGrid from './components/EpisodeGrid.vue'
import KeyHints from './components/KeyHints.vue'
import Spinner from './components/Spinner.vue'
import {
  MARK,
  barChunks,
  colsLine,
  descLine,
  ink,
  kvLine,
  markCol,
  pickLine,
} from './lib/rows'
import type { Col } from './lib/rows'
import { clip, column, displayWidth, padStart } from './lib/text'
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
    if (['enter', 'return', 'escape', 'esc'].includes(name)) {
      bridge.key(event.name)
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
  confirm: '确认下载',
  help: '快捷键',
  'job-detail': '任务详情',
  setup: '连接网关',
  home: '首页',
  search: '搜索',
  results: '搜索结果',
  detail: '剧集',
  quality: '画质',
  tmdb: 'TMDB 匹配',
  jobs: '下载任务',
  settings: '设置',
  qr: '扫码登录',
  edit: '编辑',
}

const HOME_DESC: Record<string, string> = {
  粘贴链接: '优酷 / 腾讯 HTML 页链接 / 抖音分享口令，直接解析',
  搜索: '按标题在所选平台搜索',
  榜单: '平台热榜，找片最快',
  任务: '下载队列与进度',
  设置: '网关、画质、命名与 Cookie',
}

const HINTS: Record<string, Array<[string, string]>> = {
  workspace: [
    ['Ctrl/⌥+1/2/3', '平台'],
    ['←→', '栏目切换'],
    ['tab', '焦点'],
    ['⏎', '打开'],
    ['f', '筛选'],
    ['r', '刷新'],
    ['F1', '帮助'],
  ],
  filters: [
    ['↑↓', '选择'],
    ['⏎', '应用'],
    ['esc', '取消'],
  ],
  confirm: [
    ['⏎', '确认加入队列'],
    ['o', '修改目录'],
    ['esc', '返回设置'],
  ],
  help: [
    ['↑↓/PgDn', '滚动'],
    ['esc', '返回'],
  ],
  'job-detail': [
    ['↑↓/PgDn', '滚动日志'],
    ['esc', '返回任务'],
  ],
  setup: [
    ['tab', '切换字段'],
    ['⏎', '保存并进入'],
    ['^C', '退出'],
  ],
  home: [
    ['↑↓', '移动'],
    ['⏎', '打开'],
    ['q', '退出'],
  ],
  search: [
    ['Ctrl/⌥+1/2/3', '切平台'],
    ['⏎', '搜索 / 打开链接'],
    ['esc', '返回'],
  ],
  results: [
    ['↑↓', '移动'],
    ['PgUp/Dn', '翻页移动'],
    ['⏎', '打开'],
    ['esc', '返回'],
  ],
  detail: [
    ['←→↑↓', '移动'],
    ['空格', '勾选'],
    ['⏎', '下一步'],
    ['a', '全选'],
    ['c', '清空'],
    ['A', '全选并设置'],
    ['esc', '返回'],
  ],
  quality: [
    ['↑↓', '选档'],
    ['空格', '勾选音轨'],
    ['a', '全选音轨'],
    ['←→', '画质 / 音轨'],
    ['⏎', '下一步'],
    ['esc', '返回'],
  ],
  tmdb: [
    ['↑↓', '选择'],
    ['⏎', '采用'],
    ['s', '跳过匹配'],
    ['r', '重试'],
    ['esc', '返回'],
  ],
  jobs: [
    ['↑↓/PgDn', '移动'],
    ['⏎', '查看日志'],
    ['esc', '返回'],
  ],
  settings: [
    ['↑↓', '移动'],
    ['⏎', '修改'],
    ['esc', '保存并返回'],
  ],
  edit: [
    ['⏎', '保存'],
    ['esc', '取消'],
  ],
  qr: [
    ['⏎', '刷新轮询'],
    ['esc', '取消扫码'],
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
const onAudioTab = computed(
  () => state.value.optionTab === 'audio' && audios.value.length > 0,
)
const audioPicked = computed(
  () => audios.value.filter((a) => a.selected).length,
)
const selectedEpisode = computed(() => episodes.value[state.value.cursor])

const resultView = computed(() =>
  sliceList(state.value.rows, state.value.cursor, bodyH.value - 2),
)
const tmdbView = computed(() =>
  sliceList(
    state.value.tmdbHits,
    state.value.cursor,
    Math.max(1, Math.floor(bodyH.value / 2)),
  ),
)
const qualityView = computed(() =>
  sliceList(qualities.value, state.value.qualityIndex, bodyH.value - 5),
)
const audioView = computed(() =>
  sliceList(audios.value, state.value.audioIndex, bodyH.value - 5),
)
const settingView = computed(() =>
  sliceList(settings.value, state.value.cursor, bodyH.value - 1),
)
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
const headerLine = computed(() => {
  const right = `${hostLabel(state.value.host)}  ${state.value.tunnelOk ? '● 隧道' : '○ 隧道'}`
  const cols: Col[] = [
    { text: '▌ ', cells: 2, color: c.accent, bold: true },
    { text: 'GVS', cells: 4, color: c.accent, bold: true },
    {
      text: `› ${providerName(state.value.workspace?.provider || providers.value[state.value.providerIndex] || '')} / ${SCENE_TITLES[state.value.scene] ?? 'GVS'}`,
      grow: true,
      color: c.dim,
    },
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
    case 'quality': {
      const q = qualities.value[state.value.qualityIndex]
      const a = audios.value[state.value.audioIndex]
      const n = state.value.pendingCount || 1
      return [`${n} ${isMovie.value ? '部' : '集'}`, q?.label, a?.label]
        .filter(Boolean)
        .join(' · ')
    }
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
  if (state.value.scene === 'workspace')
    return state.value.workspace?.focus === 'sections'
      ? [
          ['↑↓', '选栏目'],
          ['←→', '推荐/榜单'],
          ['tab', '内容'],
          ['r', '刷新'],
          ['F1', '帮助'],
        ]
      : [
          ['↑↓/PgDn', '移动'],
          ['⏎', '打开'],
          ['tab', '栏目'],
          ['f', '筛选'],
          ['F2', '搜索'],
          ['F1', '帮助'],
        ]
  if (state.value.scene === 'detail' && isMovie.value) {
    return [
      ['↑↓', '选版本'],
      ['空格', '勾选'],
      ['⏎', '下一步'],
      ['a', '全选'],
      ['esc', '返回'],
    ]
  }
  return HINTS[state.value.scene] ?? []
})

const ws = computed(() => state.value.workspace)
const wsSections = computed(
  () => ws.value?.sections.filter((s) => s.mode === ws.value?.mode) ?? [],
)
const wide = computed(() => W.value >= 120)
const compact = computed(() => W.value < 90)
const wsNavWidth = computed(() => (compact.value ? 0 : 22))
const wsSummaryWidth = computed(() => (wide.value ? 30 : 0))
const wsListWidth = computed(() =>
  Math.max(
    16,
    bodyW.value -
      wsNavWidth.value -
      wsSummaryWidth.value -
      (wide.value ? 4 : compact.value ? 0 : 2),
  ),
)
const wsRows = computed(() => {
  const rows = [...(ws.value?.rows ?? [])]
  if (ws.value?.more) rows.push({ title: '加载更多…', id: '__more__', sub: '' })
  return sliceList(
    rows,
    ws.value?.cursor ?? 0,
    bodyH.value - 5 - (ws.value?.error ? 3 : ws.value?.notice ? 2 : 0),
  )
})
const wsSelected = computed(() => ws.value?.rows[ws.value.cursor])
const filterRows = computed(
  () =>
    wsSections.value[ws.value?.sectionIndex ?? 0]?.filters?.flatMap((f) =>
      f.options.map((o) => ({ ...o, key: f.key, title: f.title })),
    ) ?? [],
)
const wsSectionView = computed(() =>
  sliceList(wsSections.value, ws.value?.sectionIndex ?? 0, bodyH.value - 6),
)
const filterView = computed(() =>
  sliceList(filterRows.value, state.value.cursor, bodyH.value - 2),
)
const jobView = computed(() =>
  sliceList(jobs.value, state.value.cursor, bodyH.value - 2),
)
const selectedSummary = computed(() =>
  [
    wsSelected.value?.title,
    wsSelected.value?.desc,
    wsSelected.value?.score ? `评分 ${wsSelected.value.score}` : '',
    wsSelected.value?.target?.type === 'search'
      ? '回车搜索同名候选'
      : '回车进入详情',
  ]
    .filter(Boolean)
    .join('\n\n'),
)
function wsRow(row: Row, index: number) {
  return colsLine(
    [
      {
        text: index === ws.value?.cursor ? '› ' : '  ',
        cells: 2,
        color: ws.value?.focus === 'list' ? c.accent : c.faint,
      },
      {
        text: row.rank ? String(row.rank).padStart(2, ' ') + ' ' : '   ',
        cells: 3,
        color: c.faint,
      },
      {
        text: row.title,
        grow: true,
        color: index === ws.value?.cursor ? c.text : c.dim,
      },
      {
        text:
          row.target?.type === 'search'
            ? '搜索 →'
            : row.target?.type === 'channel'
              ? '频道 →'
              : '',
        cells: 7,
        color: c.faint,
      },
    ],
    wsListWidth.value,
    index === ws.value?.cursor && ws.value?.focus === 'list',
  )
}
const helpLines = [
  '平台工作台 · 键盘操作',
  '',
  '切平台：Win 用 Ctrl+1/2/3（Windows Terminal 会吃掉 Alt+数字切标签）；Mac 用 ⌥/Alt+1/2/3（不要用 ⌘1，那是系统切窗口）',
  'F2 搜索    F3 任务    F4 设置    F1 帮助',
  '',
  'Tab / Shift+Tab 在栏目与内容列表之间切换焦点',
  '栏目焦点：←→ 推荐 / 榜单；↑↓ 选择栏目',
  'Home / End 到首尾；PgUp / PgDn 按页移动',
  'Enter 打开条目或执行当前确认',
  'F 筛选；R 刷新栏目和内容',
  '',
  '详情：空格勾选；A全选；C清空；回车下一步',
  '画质/音轨：Tab切换；空格选音轨；回车下一步',
  'TMDB：S跳过；Esc返回（不会入队）',
  '最终确认页按回车才加入下载队列',
  '',
  '输入框内方向键正常编辑文本',
  'Esc 始终返回；Ctrl+C 退出程序',
]

// --- detail screen --------------------------------------------------------
const gridRows = computed(() =>
  Math.max(1, bodyH.value - (state.value.detail?.desc ? 6 : 4)),
)

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
  return parts.length ? `  ${parts.join('  ·  ')}` : ''
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

// 画质/音轨的列宽，表头和数据共用，保证对齐。
const QUAL_COLS = { label: 12, caption: 4, res: 10, fps: 5, size: 9, id: 8, drm: 4 }
const AUDIO_COLS = { label: 18, lang: 10, codec: 12 }

function qualityHeader(): StyledText {
  return colsLine(
    [
      { text: '  ', cells: 2 },
      { text: '档位/名称', cells: QUAL_COLS.label, color: c.line },
      { text: '字幕', cells: QUAL_COLS.caption, color: c.line },
      { text: '分辨率', cells: QUAL_COLS.res, color: c.line },
      { text: 'fps', cells: QUAL_COLS.fps, align: 'right', color: c.line },
      { text: '体积', cells: QUAL_COLS.size, align: 'right', color: c.line },
      { text: 'id', cells: QUAL_COLS.id, color: c.line },
      { text: 'DRM', cells: QUAL_COLS.drm, align: 'right', color: c.line },
    ],
    bodyW.value,
  )
}

function audioHeader(): StyledText {
  return colsLine(
    [
      { text: ' '.repeat(4), cells: 4 },
      { text: '音轨', cells: AUDIO_COLS.label, color: c.line },
      { text: '语言', cells: AUDIO_COLS.lang, color: c.line },
      { text: '编码', cells: AUDIO_COLS.codec, color: c.line },
    ],
    bodyW.value,
  )
}

function qualityLine(row: Quality, selected: boolean): StyledText {
  const res =
    row.width > 0 && row.height > 0
      ? `${row.width}×${row.height}`
      : row.height > 0
        ? `${row.height}p`
        : '—'
  const size = row.size > 0 ? human(row.size) : '—'
  const caption =
    row.caption === 'soft' ? '软' : row.caption === 'hard' ? '硬' : row.caption || '—'
  const fps = row.fps && row.fps > 0 ? String(row.fps) : '—'
  const id = (row.stream || row.title || row.id).split('|')[0] || '—'
  const name =
    row.group === 'source'
      ? row.label || '原画'
      : row.group === 'encode'
        ? `⚡${row.label || id}`
        : row.label || row.title || '视频流'
  return colsLine(
    [
      markCol(selected),
      {
        text: name,
        cells: QUAL_COLS.label,
        color: selected ? c.text : c.dim,
        bold: selected,
      },
      { text: caption, cells: QUAL_COLS.caption, color: c.faint },
      { text: res, cells: QUAL_COLS.res, color: c.faint },
      {
        text: fps,
        cells: QUAL_COLS.fps,
        align: 'right',
        color: c.faint,
      },
      {
        text: size,
        cells: QUAL_COLS.size,
        align: 'right',
        color: selected ? c.text : c.faint,
      },
      { text: id, cells: QUAL_COLS.id, color: c.faint },
      {
        text: row.drm ? 'DRM' : '无',
        cells: QUAL_COLS.drm,
        align: 'right',
        color: row.drm ? c.violet : c.faint,
      },
    ],
    bodyW.value,
    selected,
  )
}

/** `▌ ✓ AAC   国语   cmfa1hd3            平台默认` —— 空格勾选，勾中的才会封进 mkv。 */
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
      { text: row.lang || '—', cells: AUDIO_COLS.lang, color: c.faint },
      { text: row.codec || '', cells: AUDIO_COLS.codec, color: c.faint },
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

/** `▌ 斗破苍穹年番   萧炎智斗蛇人族 ★9.1        优酷 · 336578` */
function resultLine(row: Row, selected: boolean, width: number): StyledText {
  const right = `${providerName(row.sub)}${row.id ? ` · ${row.id}` : ''}`
  const rightW = displayWidth(right)
  const meta = [
    row.desc,
    row.score ? `★${row.score}` : '',
    row.desc || row.score ? '' : (row.tags ?? []).join('·'),
  ]
    .filter(Boolean)
    .join('  ')
  const metaW = meta
    ? Math.min(displayWidth(meta), Math.max(0, Math.floor(width * 0.32)))
    : 0
  const titleW = Math.max(6, width - 2 - rightW - (metaW ? metaW + 2 : 0) - 1)
  const title = selected
    ? fg(c.text)(bold(column(row.title, titleW)))
    : fg(c.dim)(column(row.title, titleW))
  return new StyledText([
    selected ? fg(c.accent)(bold(MARK)) : fg(c.dim)('  '),
    title,
    metaW ? fg(c.faint)(`  ${column(meta, metaW)}`) : fg(c.dim)(''),
    fg(c.faint)(` ${right}`),
  ])
}

function jobLine(job: Job): StyledText {
  const tone = jobTone(job.status)
  const pct = Math.max(0, Math.min(100, Math.round((job.pct ?? 0) * 100)))
  const titleCells = Math.min(30, Math.max(14, Math.floor(bodyW.value * 0.34)))
  const barCells = Math.min(18, Math.max(8, Math.floor(bodyW.value * 0.16)))
  const failed = job.status === '失败'
  const trailing = failed
    ? job.err || '失败'
    : job.status === '完成'
      ? job.log || '完成'
      : job.log || job.status
  const cols: Col[] = [
    { text: `${tone.icon} `, cells: 2, color: tone.color },
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
    },
    { text: '  ', cells: 2 },
    { text: trailing, grow: true, color: failed ? c.err : c.faint },
  ]
  return colsLine(cols, bodyW.value)
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
          :content="
            ink(
              c.accent,
              ` ${providerName(ws?.provider || '')}   ${ws?.mode === 'home' ? '[推荐]   榜单' : ' 推荐   [榜单]'}${ws?.compatibility ? '  · 旧网关兼容模式' : ''}`,
            )
          "
          :width="bodyW"
          :height="1"
          :truncate="true"
        />
        <Text
          :content="
            ink(
              c.faint,
              `${ws?.category || '选择栏目'}  ${ws?.loading ? '加载中…' : `${ws?.rows.length ?? 0} 条`}${Object.keys(ws?.filters ?? {}).length ? ` · ${Object.values(ws?.filters ?? {}).join('/')}` : ''}`,
            )
          "
          :width="bodyW"
          :height="1"
          :truncate="true"
        />
        <Box :height="1" />
        <Box flexDirection="row" :height="Math.max(2, bodyH - 5)">
          <Box
            v-if="!compact || ws?.focus === 'sections'"
            flexDirection="column"
            :width="compact ? bodyW : wsNavWidth"
            :paddingRight="compact ? 0 : 2"
          >
            <Text
              :content="
                ink(
                  ws?.focus === 'sections' ? c.accent : c.faint,
                  '栏目 · Tab 切换焦点',
                )
              "
              :height="1"
            />
            <Text
              v-for="entry in wsSectionView.rows"
              :key="entry.item.id"
              :content="
                ink(
                  entry.index === ws?.sectionIndex ? c.text : c.dim,
                  ` ${entry.index === ws?.sectionIndex ? '›' : ' '} ${entry.item.title}`,
                )
              "
              :bg="entry.index === ws?.sectionIndex ? c.sel : undefined"
              :width="compact ? bodyW : wsNavWidth - 2"
              :height="1"
              :truncate="true"
            />
          </Box>
          <Box
            v-if="!compact || ws?.focus !== 'sections'"
            flexDirection="column"
            :width="wsListWidth"
          >
            <Text
              v-if="ws?.error"
              :content="ink(c.err, ws.error + ' · R 重试')"
              :width="wsListWidth"
              :height="3"
            />
            <Text
              v-else-if="ws?.notice"
              :content="ink(c.warn, ws.notice)"
              :width="wsListWidth"
              :height="2"
            />
            <Text
              v-if="!wsRows.total && !ws?.loading && !ws?.notice && !ws?.error"
              :content="
                ink(
                  c.dim,
                  providers.length
                    ? '暂无内容 · R 刷新 / F2 搜索'
                    : '当前 Key 没有可浏览的平台 · F4 设置',
                )
              "
              :width="wsListWidth"
              :height="2"
            />
            <Text
              v-if="ws?.loading && !wsRows.total"
              :content="ink(c.faint, '正在读取平台栏目与内容…')"
              :height="1"
            />
            <Text
              v-for="entry in wsRows.rows"
              :key="entry.index"
              :content="wsRow(entry.item, entry.index)"
              :width="wsListWidth"
              :height="1"
              wrapMode="none"
              :truncate="true"
              :bg="
                entry.index === ws?.cursor && ws?.focus === 'list'
                  ? c.sel
                  : undefined
              "
            />
          </Box>
          <Box
            v-if="wide"
            :width="wsSummaryWidth + 2"
            :paddingLeft="2"
            flexDirection="column"
            ><Text :content="ink(c.faint, '选中内容')" :height="2" /><Text
              :content="ink(c.dim, selectedSummary)"
              :width="wsSummaryWidth"
              :height="Math.max(1, bodyH - 8)"
          /></Box>
        </Box>
        <Text
          :content="
            ink(
              c.faint,
              `${ws?.source || '公开内容'}${!wide && wsSelected?.desc ? ` · ${wsSelected.desc}` : ''}`,
            )
          "
          :height="1"
          :width="bodyW"
          :truncate="true"
        />
      </Box>
      <Box v-else-if="state.scene === 'filters'" flexDirection="column"
        ><Text
          :content="ink(c.accent, '筛选 · 回车应用 / Esc 取消')"
          :height="2" /><Text
          v-for="entry in filterView.rows"
          :key="entry.item.key + entry.item.value"
          :content="
            pickLine(
              `${entry.item.title} / ${entry.item.label}`,
              '',
              bodyW,
              entry.index === state.cursor,
            )
          "
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
          :content="ink(index === 0 ? c.accent : c.dim, line)"
          :height="1"
          :width="bodyW"
          :truncate="true"
      /></Box>
      <Box
        v-else-if="state.scene === 'confirm'"
        flexDirection="column"
        :width="bodyW"
        ><Text
          :content="ink(c.accent, '确认下载 · 此前尚未创建任务', true)"
          :height="H < 24 ? 1 : 2" /><Text
          :content="ink(c.text, state.confirmation?.title || '')"
          :height="H < 24 ? 1 : 2"
          :width="bodyW"
          :truncate="true" /><Text
          v-for="(value, label) in {
            集数: state.confirmation?.episodes,
            画质: state.confirmation?.quality,
            音轨: state.confirmation?.audio,
            目录: state.confirmation?.directory,
            命名示例: state.confirmation?.name,
          }"
          :key="label"
          :content="kvLine(String(label), value || '', bodyW, false, c.dim)"
          :height="H < 24 ? 1 : 2"
          :width="bodyW"
          :truncate="true" /><Text
          :content="
            ink(c.accent, '[ Enter 确认加入队列 ]   O 修改目录   Esc 返回')
          "
          :height="1"
          :width="bodyW"
          :truncate="true"
      /></Box>
      <Box v-else-if="state.scene === 'job-detail'" flexDirection="column"
        ><Text
          v-for="(line, index) in (state.jobDetailLines ?? []).slice(
            state.logOffset ?? 0,
            (state.logOffset ?? 0) + bodyH,
          )"
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
          :content="
            ink(c.faint, '粘贴优酷 / 腾讯 v.qq.com 页链接或抖音口令，也可搜索标题')
          "
          :height="1"
        />
        <Box flexDirection="row" :height="1" :marginTop="1">
          <Text
            v-for="(provider, index) in providers"
            :key="provider"
            :height="1"
            :bg="index === state.providerIndex ? c.sel : undefined"
            :content="
              ink(
                index === state.providerIndex ? c.accent : c.faint,
                ` ${providerName(provider)} `,
                index === state.providerIndex,
              )
            "
          />
        </Box>
        <Box
          flexDirection="row"
          :width="bodyW"
          :height="3"
          :marginTop="1"
          :border="true"
          borderStyle="rounded"
          :borderColor="c.line"
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
      </Box>

      <!-- results -->
      <Box
        v-else-if="state.scene === 'results'"
        flexDirection="column"
        :width="bodyW"
      >
        <Text
          v-if="!resultView.total"
          :content="ink(c.faint, '没有结果。换个关键词或平台再试，esc 返回')"
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
          v-if="state.detail?.desc"
          :content="ink(c.faint, '  ' + state.detail.desc)"
          :width="bodyW"
          :height="2"
          wrapMode="char"
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
                  text: `${state.pendingCount || 1} ${isMovie ? '部' : '集'}将使用同一档画质 · ⏎ 下一步确认`,
                  grow: true,
                  color: c.faint,
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
        <Box flexDirection="row" :height="1" :marginTop="1">
          <Text
            :height="1"
            :bg="onAudioTab ? undefined : c.sel"
            :content="
              ink(
                onAudioTab ? c.faint : c.accent,
                ` 画质 ${qualities.length} 档 `,
                !onAudioTab,
              )
            "
          />
          <Text
            v-if="audios.length"
            :height="1"
            :bg="onAudioTab ? c.sel : undefined"
            :content="
              ink(
                onAudioTab ? c.accent : c.faint,
                audios.every(a => a.embedded) ? ' 内嵌音轨 · 随画质切换 ' : ` 音轨 ${audios.length} 条 · 已选 ${audioPicked} `,
                onAudioTab,
              )
            "
          />
          <Text :height="1" :content="ink(c.line, '  ←→ 切换')" />
        </Box>
        <Text :height="1" :content="' '" />
        <Text
          :height="1"
          :content="onAudioTab ? audioHeader() : qualityHeader()"
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
          :truncate="true"
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
          :content="ink(c.faint, '选中后写入剧名 / 年份 / 简介，esc 直接跳过')"
          :height="1"
          :marginBottom="1"
        />
        <Text
          v-if="!tmdbView.total"
          :content="ink(c.dim, '暂无匹配候选 · S 跳过 / R 重试 / Esc 返回')"
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
                c.faint,
                `  ${clip(entry.item.overview, Math.max(8, bodyW - 4))}`,
              )
            "
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
          :content="
            ink(c.faint, '还没有任务。回首页粘贴链接或搜索下载，esc 返回')
          "
          :height="1"
        />
        <Text
          v-for="entry in jobView.rows"
          :key="entry.item.id"
          :content="jobLine(entry.item)"
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
          :content="ink(c.faint, '⏎ 修改 / 切换，esc 保存并返回')"
          :height="1"
          :marginBottom="1"
        />
        <Text
          v-for="entry in settingView.rows"
          :key="entry.item.label"
          :width="bodyW"
          :height="1"
          wrapMode="none"
          :truncate="true"
          :bg="entry.index === state.cursor ? c.sel : undefined"
          :content="
            kvLine(
              entry.item.label,
              entry.item.value,
              bodyW,
              entry.index === state.cursor,
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
        <Text
          :content="ink(c.faint, '⏎ 保存 · esc 取消')"
          :height="1"
          :marginTop="1"
        />
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
      <KeyHints :hints="hints" :width="bodyW" />
    </Box>
  </Box>
</template>
