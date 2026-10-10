<script setup lang="ts">
// 画质: the quality table and, on ←/→, the audio track table in the same
// frame. The two share one cursor treatment so the switch never moves.
import { computed } from 'vue-termui'
import { Box, StyledText, Text, fg } from 'vue-termui'
import type { TextChunk } from 'vue-termui'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import { chipChunks, colsLine, hr, markCol, tabChunks } from '../lib/rows.ts'
import type { Col } from '../lib/rows.ts'
import { column, displayWidth } from '../lib/text.ts'
import { c } from '../lib/theme.ts'
import { qualityCaptionText, qualityFpsText, qualityHdrText, qualityResolution } from '../lib/quality.ts'
import { episodeRanges, qualityColumns, selectedAudioText } from '../lib/ui-layout.ts'
import { resolveDefaultAudioId } from '../lib/audio-selection.ts'
import { iqcnAudioGroups } from '../lib/iqcn-audio-ui.ts'
import { human } from '../lib/util.ts'
import { audioTab, optionWindow } from '../lib/view.ts'
import type { Audio, Quality, Snapshot } from '../types.ts'

/** Chrome above the first data row: header, tabs, head and hairline. */
const CHROME_ROWS = 5
/** Left inset shared by the tabs and the table. */
const INSET = 2

const props = defineProps<{
  state: Snapshot
  /** bodyW */
  width: number
  /** bodyH */
  height: number
}>()

const bodyW = computed(() => props.width)
const bodyH = computed(() => props.height)

const qualities = computed(() => props.state.qualities ?? [])
const audios = computed(() => props.state.audios ?? [])
const audioTitles = computed(() => new Map(iqcnAudioGroups(audios.value.filter(audio => audio.id.startsWith('iqcn:'))).flatMap(group => group.items.map(row => [row.audio.id, row.title] as const))))
const detail = computed(() => props.state.detail)
const isMovie = computed(() =>
  detail.value?.kind === 'movie' || /电影/.test(detail.value?.category ?? ''),
)

const qualityAction = computed(() => {
  const q = qualities.value[props.state.qualityIndex]
  const n = props.state.pendingCount || 1
  const picked = audios.value.filter((a) => a.selected).map((a) => a.label)
  const audio = !audios.value.length
    ? ''
    : picked.length
      ? picked.slice(0, 2).join('+')
      : '默认音轨'
  const title = props.state.detail?.title || props.state.detailTitle || ''
  const numbers = (props.state.pendingEpisodes ?? []).filter((n) => n > 0)
  const episode = isMovie.value || !numbers.length
    ? ''
    : episodeRanges(numbers).split('、').map((part) => (part.includes('–') ? `E${part.replace('–', '–E')}` : `E${part}`)).join('、')
  return [title, episode, `下载 ${n} ${isMovie.value ? '部' : '集'}`, q?.label, audio]
    .filter(Boolean)
    .join(' · ')
})
const onAudioTab = computed(() => audioTab(props.state))
const audioPicked = computed(
  () => audios.value.filter((a) => a.selected).length,
)

/**
 * VIP 徽标要分清三件事：片源要不要 VIP、账号是什么状态、**这次取流到底成不成**。
 * 最后一条来自 `play` 的 `quality_gate`，比会员接口可信——它是真的取到流了。
 */
const vipNotice = computed(() => {
  if (!detail.value?.vip) return null
  const probe = props.state.vipProbe
  const acc = props.state.ykAccount
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
  const probe = props.state.vipProbe
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
  const acc = props.state.ykAccount
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

/** The badge in the header: the VIP story when the title needs it, else rights. */
const badge = computed(() =>
  props.state.detail?.vip ? vipNotice.value ?? { text: 'VIP', color: c.violet } : rightsChip.value,
)
const badgeChips = computed<TextChunk[]>(() => chipChunks(badge.value.text, badge.value.color))

const qualityView = computed(() =>
  optionWindow(qualities.value, props.state.qualityIndex, bodyH.value - 3),
)
const audioView = computed(() =>
  optionWindow(audios.value, props.state.audioIndex, bodyH.value - 3),
)

/** Rows of `画质 / 音轨` tabs, with the `←→ 切换` hint pinned right. */
const tabsLine = computed(() => {
  const chunks: TextChunk[] = [
    { __isChunk: true, text: ' '.repeat(INSET) },
    ...tabChunks(`画质 ${qualities.value.length} 档`, !onAudioTab.value),
  ]
  if (audios.value.length)
    chunks.push(
      ...tabChunks(
        audios.value.every((a) => a.embedded)
          ? '内嵌音轨 · 随画质切换'
          : `音轨 ${audios.value.length} 条 · 已选 ${audioPicked.value}`,
        onAudioTab.value,
      ),
    )
  return colsLine(
    [
      { chunks: () => chunks, cells: chunks.reduce((n, ch) => n + displayWidth(ch.text), 0) },
      { text: audios.value.length ? '←→ 切换' : '', grow: true, align: 'right', color: c.faint },
    ],
    bodyW.value,
  )
})

/** 档位名：杜比视界 / HDR* 在表里要一眼看出来，其它按正文色。 */
function isPremiumName(row?: Quality): boolean {
  if (!row) return false
  const hay = `${row.label || ''} ${row.title || ''} ${row.codec || ''}`
  return /杜比|Dolby|HDR|DVH1/i.test(hay)
}

/**
 * One row of the quality table. `header` renders the column titles instead of
 * a row; `cells` comes from `colsLine`, so the name column pads exactly and a
 * trailing spacer keeps a short table from stretching across a wide terminal.
 */
function qualityTable(header: boolean, row?: Quality, selected = false): StyledText {
  const width = bodyW.value
  const tone = selected ? c.text : c.dim
  const name =
    !row
      ? '档位'
      : row.group === 'source'
        ? row.label || '原画'
        : row.group === 'encode'
          ? `⚡${row.label || (row.stream || row.title || '').split('|')[0] || '转码'}`
          : row.label || row.title || '视频流'
  const encodeOf = (q?: Quality) => (q ? q.encodeTag || q.codec || '—' : '')
  // 杜比视界 / HDR 是这张表里真正要挑的东西，所以它们比普通档位亮一档。
  const nameColor = header
    ? c.faint
    : selected
      ? c.text
      : isPremiumName(row)
        ? c.warn
        : c.text
  const cols: Col[] = [
    // The gutter doubles as the cursor bar's home, so both tables keep it
    // whether or not a row is selected and the columns never jump.
    header ? markCol(false) : markCol(selected),
  ]
  for (const [i, col] of qualityColumns(width, qualities.value).entries()) {
    if (i) cols.push({ text: '', cells: 2 })
    if (col.key === 'label') {
      cols.push({ chunks: nameChunks(name, nameColor), cells: col.width })
      continue
    }
    const value = !row ? '' : col.key === 'codec' ? encodeOf(row)
      : col.key === 'size' ? row.size > 0 ? human(row.size) : '—'
      : col.key === 'resolution' ? qualityResolution(row.width, row.height)
      : col.key === 'caption' ? qualityCaptionText(row.caption, row.captionProbe) || '—'
      : col.key === 'hdr' ? qualityHdrText(row.hdr) || '—'
      : col.key === 'fps' ? qualityFpsText(row.fps) || '—'
      : row.drm && row.drm !== 'none' ? 'DRM' : '—'
    cols.push({ text: header ? col.title : value, cells: col.width, align: col.key === 'size' ? 'right' : 'left', color: header ? c.faint : tone })
  }
  cols.push({ text: '', grow: true })
  return colsLine(cols, width, selected && !header)
}

/** ` 档位名 ` padded to the column and painted; premium names get the warm tone. */
function nameChunks(label: string, color: string) {
  return (cells: number): TextChunk[] => [fg(color)(column(label, cells))]
}

const AUDIO_COLS = { label: 18, lang: 10, codec: 12 }

function audioHeader(): StyledText {
  // The 4-cell gutter matches `markCol` + the checkbox column of a data row.
  return colsLine(
    [
      { text: ' '.repeat(4), cells: 4 },
      { text: '音轨', cells: AUDIO_COLS.label, color: c.faint },
      { text: '', cells: 2 },
      { text: '语言', cells: AUDIO_COLS.lang, color: c.faint },
      { text: '', cells: 2 },
      { text: '编码', cells: AUDIO_COLS.codec, color: c.faint },
    ],
    bodyW.value,
  )
}

function audioLine(row: Audio, selected: boolean): StyledText {
  const muxDefault = resolveDefaultAudioId(audios.value, audios.value.filter(a => a.selected).map(a => a.id)) === row.id
  const tags: TextChunk[] = []
  if (muxDefault) tags.push(...chipChunks('默认播放', c.ok))
  if (row.isDefault) {
    if (tags.length) tags.push({ __isChunk: true, text: ' ' })
    tags.push(...chipChunks('平台默认', c.dim))
  }
  return colsLine(
    [
      markCol(selected),
      {
        text: row.selected ? '✓ ' : '□ ',
        cells: 2,
        color: row.selected ? c.ok : c.faint,
      },
      {
        text: audioTitles.value.get(row.id) || row.label || row.id,
        cells: AUDIO_COLS.label,
        color: selected ? c.text : c.dim,
        bold: selected,
      },
      { text: '', cells: 2 },
      { text: row.lang || '—', cells: AUDIO_COLS.lang, color: c.dim },
      { text: '', cells: 2 },
      { text: row.codec || '', cells: AUDIO_COLS.codec, color: c.dim },
      {
        chunks: () => tags,
        cells: tags.reduce((n, ch) => n + displayWidth(ch.text), 0),
      },
      { text: '', grow: true },
    ],
    bodyW.value,
    selected,
  )
}
</script>

<template>
  <Box flexDirection="column" :width="bodyW">
    <PageHeader :title="qualityAction" :rightChunks="badgeChips" :width="bodyW" />
    <Text
      :content="tabsLine"
      :height="1"
      :width="bodyW"
      wrapMode="none"
      :truncate="true"
    />
    <Text
      :height="1"
      :content="onAudioTab ? audioHeader() : qualityTable(true)"
      :width="bodyW"
      wrapMode="none"
      :truncate="false"
    />
    <Text :content="hr(bodyW)" :height="1" :width="bodyW" wrapMode="none" />
    <EmptyState
      v-if="!qualities.length && !state.busy"
      :width="bodyW"
      :height="Math.max(1, bodyH - CHROME_ROWS)"
      tone="err"
      :message="state.status || '没有可用画质'"
      hint="esc 返回，或稍后重试"
    />
    <Text
      v-for="entry in onAudioTab ? audioView.rows : qualityView.rows"
      :key="`${onAudioTab ? 'a' : 'q'}-${entry.index}`"
      :width="bodyW"
      :height="1"
      wrapMode="none"
      :truncate="false"
      :bg="
        entry.index === (onAudioTab ? state.audioIndex : state.qualityIndex)
          ? c.sel
          : undefined
      "
      :content="
        onAudioTab
          ? audioLine(entry.item as Audio, entry.index === state.audioIndex)
          : qualityTable(false, entry.item as Quality, entry.index === state.qualityIndex)
      "
    />
    <Box flexDirection="column" :width="bodyW" :marginTop="1">
      <Text :content="`已选画质：${qualities[state.qualityIndex]?.label || '—'}`" :width="bodyW" :height="1" :truncate="true" wrapMode="none" />
      <Text :content="`已选音轨：${selectedAudioText(audios)}`" :width="bodyW" :height="1" :truncate="true" wrapMode="none" />
    </Box>
  </Box>
</template>
