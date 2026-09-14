<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue-termui'
import { Box, Input, Text, useExit, onKeyDown, useTerminalSize } from 'vue-termui'
import { Bridge, type Snapshot } from './bridge'

const exit = useExit()
const bridge = new Bridge()
const state = ref<Snapshot>(bridge.snapshot ?? {
  scene: 'setup', host: '', status: '', tunnelOk: false, cursor: 0, providerIndex: 0, qualityIndex: 0,
  hostFocused: true, keyFocused: false, keyConfigured: false,
})
const query = ref('')
const host = ref('')
const key = ref('')
const edit = ref('')
const { width, height } = useTerminalSize()

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
onUnmounted(() => { stop(); bridge.close() })

watch(query, (value) => { if (state.value.scene === 'search') bridge.set('query', value) })
watch(host, (value) => { if (state.value.scene === 'setup') bridge.set('host', value) })
watch(key, (value) => { if (state.value.scene === 'setup') bridge.set('key', value) })
watch(edit, (value) => { if (state.value.scene === 'edit') bridge.set('edit', value) })

onKeyDown((event) => {
  const name = event.name.toLowerCase()
  if (event.ctrl && name === 'c') { exit(); return }
  if (name === 'q' && state.value.scene === 'home') { exit(); return }

  // Input renderables already consume text editing keys and update their
  // v-model. Forwarding those same keys to the hidden Bubble Tea model makes
  // the value change twice (and can move the caret unexpectedly). Keep the
  // bridge for navigation/submit keys only while an input is focused.
  const inputScene = state.value.scene === 'setup' || state.value.scene === 'search' || state.value.scene === 'edit'
  const navigationKey = ['enter', 'return', 'escape', 'esc', 'tab', 'left', 'right', 'up', 'down', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(name)
  if (inputScene && !navigationKey) return
  // OpenTUI reports Shift as a modifier while keeping the key name lowercase
  // on some terminals. Preserve the uppercase rune so Bubble Tea can still
  // distinguish `A` (whole-series download) from `a` (select all episodes).
  const forwardedName = event.shift && event.name.length === 1 ? event.name.toUpperCase() : event.name
  bridge.key(forwardedName, { ctrl: event.ctrl, alt: event.option, shift: event.shift })
})

const heading = computed(() => ({
  setup: '解锁 GVS', home: 'GVS', search: '搜索', results: '搜索结果', detail: state.value.detailTitle || '剧集',
  quality: '画质', tmdb: 'TMDB 匹配', jobs: '下载任务', settings: '设置', qr: '优酷扫码', edit: state.value.editField || '编辑',
}[state.value.scene] ?? 'GVS'))
const sceneHint = computed(() => state.value.footer || '↑↓ 移动 · Enter 确认 · Esc 返回')
const statusColor = computed(() => state.value.tunnelOk ? '#6ee7b7' : '#64748b')
function windowed<T>(items: T[] | undefined, cursor: number, room = 10) {
  const all = items ?? []
  // Snapshots from an older bridge may not contain a dedicated quality index.
  // Never let an undefined/NaN cursor reach Array.slice, otherwise the list
  // silently renders empty and the UI displays NaN in derived values.
  const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0
  const size = Math.max(3, Math.min(room, all.length || 3))
  let start = Math.max(0, safeCursor - Math.floor(size / 2))
  if (start + size > all.length) start = Math.max(0, all.length - size)
  return all.slice(start, start + size).map((item, offset) => ({ item, index: start + offset }))
}
const qualityCursor = computed(() => Number.isFinite(state.value.qualityIndex) ? state.value.qualityIndex : state.value.cursor)
const visibleRows = computed(() => windowed(state.value.rows, state.value.cursor, height.value - 8))
const visibleEpisodes = computed(() => windowed(state.value.episodes, state.value.cursor, height.value - 10))
const visibleQualities = computed(() => windowed(state.value.qualities, qualityCursor.value, height.value - 8))
const visibleTMDBHits = computed(() => windowed(state.value.tmdbHits, state.value.cursor, height.value - 8))
const visibleJobs = computed(() => windowed(state.value.jobs, 0, height.value - 8))
const visibleSettings = computed(() => windowed(state.value.settings, state.value.cursor, height.value - 8))

function displayKey() { return state.value.keyConfigured ? '已配置' : '未配置' }
function qualitySize(size: number | undefined) {
  const value = Number(size)
  return Number.isFinite(value) && value > 0 ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—'
}
function percent(value: number | undefined) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n * 100)))
}
</script>

<template>
  <Box :width="width" :height="height" flexDirection="column" backgroundColor="#07090d" padding="1">
    <Box justifyContent="space-between" border borderStyle="rounded" padding="1" :marginBottom="1">
      <Text bold fg="#fb7185">◆ GVS</Text>
      <Text fg="#94a3b8">{{ state.host || '未配置网关' }}</Text>
      <Text :fg="statusColor">{{ state.tunnelOk ? '● 隧道已连' : '○ 隧道未连' }}</Text>
    </Box>
    <Text v-if="state.status" fg="#fbbf24">{{ state.status }}</Text>

    <Box v-if="state.scene === 'setup'" flexDirection="column" border borderStyle="rounded" padding="2" :marginTop="1">
      <Text bold fg="#f8fafc">连接到你的网关</Text>
      <Text fg="#94a3b8">输入地址和 API Key，配置会保存在用户目录。</Text>
      <Text :marginTop="1" fg="#cbd5e1">网关地址</Text>
      <Input v-model="host" placeholder="http://127.0.0.1:8080" :focus="state.hostFocused" />
      <Text :marginTop="1" fg="#cbd5e1">API Key</Text>
      <Input v-model="key" placeholder="sk_live_..." :focus="state.keyFocused" />
      <Text :marginTop="1" fg="#64748b">Tab 切换 · Enter 进入</Text>
    </Box>

    <Box v-else-if="state.scene === 'home'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">欢迎回来</Text>
      <Text fg="#94a3b8">用键盘操作你的多平台取链客户端。</Text>
      <Box v-for="(item, index) in state.homeItems" :key="item" padding="1" :backgroundColor="index === state.cursor ? '#3b1220' : undefined">
        <Text :fg="index === state.cursor ? '#fb7185' : '#e2e8f0'">{{ index === state.cursor ? '› ' : '  ' }}{{ item }}</Text>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'search'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">选择平台</Text>
      <Box>
        <Text v-for="(provider, index) in state.providers" :key="provider" :fg="index === state.providerIndex ? '#fb7185' : '#94a3b8'" padding="1">
          {{ index === state.providerIndex ? `[${provider}]` : provider }}
        </Text>
      </Box>
      <Text fg="#94a3b8">搜索标题或粘贴链接</Text>
      <Input v-model="query" placeholder="搜索标题 / 粘贴链接" :focus="state.scene === 'search'" />
    </Box>

    <Box v-else-if="state.scene === 'results'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">{{ state.rows?.length ?? 0 }} 条结果</Text>
      <Box v-for="entry in visibleRows" :key="`${entry.item.sub}-${entry.item.id}`" padding="1" :backgroundColor="entry.index === state.cursor ? '#3b1220' : undefined">
        <Text :fg="entry.index === state.cursor ? '#fb7185' : '#e2e8f0'">{{ entry.index === state.cursor ? '› ' : '  ' }}{{ entry.item.title }}</Text>
        <Text fg="#64748b">  {{ entry.item.sub }} · {{ entry.item.id }}</Text>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'detail'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">{{ state.detailTitle }} · {{ state.episodes?.length ?? 0 }} 集</Text>
      <Box flexWrap="wrap">
        <Box v-for="entry in visibleEpisodes" :key="entry.item.vid" width="8" padding="1" :backgroundColor="entry.index === state.cursor ? '#3b1220' : undefined">
          <Text :fg="entry.item.selected ? '#6ee7b7' : entry.index === state.cursor ? '#fb7185' : '#cbd5e1'">{{ entry.item.selected ? '✓' : '□' }} E{{ String(entry.item.number || entry.index + 1).padStart(2, '0') }}</Text>
        </Box>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'quality'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">选择画质 · {{ state.detailTitle }}</Text>
      <Text fg="#94a3b8">{{ state.pendingCount || 1 }} 集将使用同一档画质 · Enter 应用并开始下载</Text>
      <Box v-for="entry in visibleQualities" :key="`${entry.item.label}-${entry.index}`" padding="1" :backgroundColor="entry.index === qualityCursor ? '#3b1220' : undefined">
        <Text :fg="entry.index === qualityCursor ? '#fb7185' : '#e2e8f0'">{{ entry.index === qualityCursor ? '› ' : '  ' }}{{ entry.item.label || entry.item.title || '视频流' }}</Text>
        <Text fg="#94a3b8"> {{ entry.item.width }}x{{ entry.item.height }} · {{ entry.item.codec || '—' }} · {{ qualitySize(entry.item.size) }} · {{ entry.item.drm || '无 DRM' }}</Text>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'tmdb'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">匹配 TMDB · Esc 跳过</Text>
      <Box v-for="entry in visibleTMDBHits" :key="entry.item.id" flexDirection="column" padding="1" :backgroundColor="entry.index === state.cursor ? '#3b1220' : undefined">
        <Text :fg="entry.index === state.cursor ? '#fb7185' : '#e2e8f0'">{{ entry.index === state.cursor ? '› ' : '  ' }}{{ entry.item.name || entry.item.title }}{{ entry.item.year ? ` (${entry.item.year})` : '' }} · tmdb-{{ entry.item.id }}</Text>
        <Text v-if="entry.item.overview" fg="#64748b">  {{ entry.item.overview }}</Text>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'jobs'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">下载任务</Text>
      <Box v-if="!state.jobs?.length"><Text fg="#94a3b8">没有任务</Text></Box>
      <Box v-for="entry in visibleJobs" :key="entry.item.id" flexDirection="column" padding="1">
        <Text :fg="entry.item.status === '失败' ? '#f87171' : entry.item.status === '完成' ? '#6ee7b7' : '#e2e8f0'">{{ entry.item.status }} · {{ entry.item.title }}</Text>
        <Text fg="#94a3b8">{{ percent(entry.item.pct) }}% {{ entry.item.log || entry.item.err }}</Text>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'settings'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">设置</Text>
      <Box v-for="entry in visibleSettings" :key="entry.item.label" padding="1" :backgroundColor="entry.index === state.cursor ? '#3b1220' : undefined">
        <Text :fg="entry.index === state.cursor ? '#fb7185' : '#e2e8f0'">{{ entry.index === state.cursor ? '› ' : '  ' }}{{ entry.item.label }}</Text>
        <Text fg="#94a3b8">  {{ entry.item.value }}</Text>
      </Box>
    </Box>

    <Box v-else-if="state.scene === 'edit'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">{{ state.editField }}</Text>
      <Input v-model="edit" focus />
    </Box>

    <Box v-else-if="state.scene === 'qr'" flexDirection="column" border borderStyle="rounded" padding="1">
      <Text bold fg="#f8fafc">请用优酷 App 扫码登录</Text>
      <Text>{{ state.qrAscii }}</Text>
    </Box>

    <Box :marginTop="1"><Text fg="#64748b">{{ sceneHint }}</Text></Box>
  </Box>
</template>
