<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AudioView, EnqueueRequest, NamingPreview, TmdbHit, TmdbSeason } from '@shared/api'
import { supportsTmdb } from '@shared/api'
import { resolveDefaultAudioId } from '@shared/audio-selection'
import { defaultTmdbHit } from '@shared/tmdb-selection'
import { audioChannels, audioCodec, hdrKind, resolutionTier, videoCodec } from '@shared/media-specs'
import { DEFAULT_RULES, parseRules, pickBest, type RuleCandidate } from '@shared/rule-groups'
import Icon from '../components/Icon.vue'
import Skeleton from '../components/Skeleton.vue'
import IQCNAudioPicker from '../components/IQCNAudioPicker.vue'
import { preferredQualityIndex } from '@shared/ui-prefs'
import { accountsOf, back, errText, go, gvs, human, openQuality, openSettings, prefs, store, subscriptionOf, toast } from '../store'
import AccountPicker from '../components/AccountPicker.vue'
import { reducedMotion } from '../motion'

defineOptions({ name: 'QualityView' })
/** embedded：嵌在剧集页里（不显示返回与标题，默认收起手动选择） */
const props = defineProps<{ embedded?: boolean; footerTarget?: HTMLElement | null }>()
const panel = ref<HTMLElement | null>(null)
function revealPanel() {
  if (props.embedded) panel.value?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'instant' : 'smooth' })
}
onMounted(revealPanel)
watch(() => store.probing, revealPanel, { flush: 'post' })
/** 嵌入模式下是否展开「手动选择画质/音轨」 */
const manual = ref(!props.embedded)

const d = computed(() => store.detail)
const probe = computed(() => store.probe)
const qIndex = ref(0)
const audioIds = ref<string[]>([])
/** Separately downloadable subtitle renditions (Apple TV / Disney+); empty = subtitles follow the video. */
const subtitles = computed(() => probe.value?.subtitles ?? [])
const subtitleIds = ref<string[]>([])
watch(subtitles, (list) => { subtitleIds.value = list.filter((s) => s.selected).map((s) => s.id) }, { immediate: true })
function toggleSubtitle(id: string) {
  subtitleIds.value = subtitleIds.value.includes(id) ? subtitleIds.value.filter((x) => x !== id) : [...subtitleIds.value, id]
}
const preferredAudioId = ref('')
const tmdb = ref<TmdbHit | null>(null)
const tmdbHits = ref<TmdbHit[]>([])
const tmdbLoading = ref(false)
const tmdbError = ref('')
const tmdbOpen = ref(false)
const seasons = ref<TmdbSeason[]>([])
const selectedSeason = ref('')
const seasonsLoading = ref(false)
const seasonsError = ref('')
const seasonsWarning = ref('')
let seasonsSeq = 0
const naming = ref<NamingPreview | null>(null)
const starting = ref(false)
const manualKind = ref(false)
let tmdbSeq = 0
const isMovie = computed(() => d.value?.kind === 'movie')
const miguApp = computed(() => d.value?.provider === 'migu' && !d.value.id.startsWith('tv:') && !d.value.id.startsWith('tv-series:'))
const canMatchTmdb = computed(() => supportsTmdb(d.value?.provider))

const quality = computed(() => probe.value?.qualities[qIndex.value] ?? null)
const audios = computed<AudioView[]>(() => {
  const q = quality.value
  if (q && q.audios.length) return q.audios
  return probe.value?.audios ?? []
})
const defaultAudioId = computed(() => resolveDefaultAudioId(audios.value, audioIds.value, preferredAudioId.value))

function defaultAudios() {
  const list = audios.value
  const pre = list.filter((a) => a.selected || a.embedded).map((a) => a.id)
  const fallback = resolveDefaultAudioId(list, list.map((a) => a.id))
  audioIds.value = pre.length ? pre : fallback ? [fallback] : []
  // 切换画质时，保留仍然可用的默认音轨，并确保它在下载选择里。
  if (list.some((a) => a.id === preferredAudioId.value && !a.embedded) && !audioIds.value.includes(preferredAudioId.value)) {
    audioIds.value.push(preferredAudioId.value)
  }
  reconcileDefaultAudio()
}

function reconcileDefaultAudio() {
  if (!audioIds.value.includes(preferredAudioId.value)) preferredAudioId.value = ''
}

watch(
  probe,
  (p) => {
    ++tmdbSeq
    tmdbLoading.value = false
    qIndex.value = p ? preferredQualityIndex(p.qualities, prefs().defaultQuality) : 0
    preferredAudioId.value = ''
    tmdb.value = null
    tmdbHits.value = []
    tmdbError.value = ''
    tmdbOpen.value = false
    manualKind.value = false
    if (!p) return
    defaultAudios()
    void loadTmdb()
  },
  { immediate: true },
)
watch(qIndex, defaultAudios)

/** 按语言分组，一排一种语言 */
const audioGroups = computed(() => {
  const groups: Array<{ lang: string; items: AudioView[] }> = []
  for (const a of audios.value) {
    const lang = a.lang || '音轨'
    let g = groups.find((x) => x.lang === lang)
    if (!g) groups.push((g = { lang, items: [] }))
    g.items.push(a)
  }
  return groups
})
/** 音轨全部内嵌在视频里（红果/黄果）：没得选，只用一行说明，别摆一排不能点的芯片 */
const embeddedOnly = computed(() => audios.value.length > 0 && audios.value.every((a) => a.embedded))
const embeddedNote = computed(() =>
  audios.value
    .map((a) => [a.lang, a.label].filter((t) => t && !t.includes('未提供')).join(' '))
    .filter(Boolean)
    .join('、'),
)
const pickedCount = computed(() => audios.value.filter((a) => a.embedded || audioIds.value.includes(a.id)).length)
const audioSummary = computed(() => audios.value.filter(a => a.embedded || audioIds.value.includes(a.id)).map(a => [a.lang, a.label].filter(Boolean).join(' ')).join('、'))
function pickAll() {
  audioIds.value = audios.value.filter((a) => !a.embedded).map((a) => a.id)
  reconcileDefaultAudio()
}
function pickDefault() {
  reconcileDefaultAudio()
  audioIds.value = defaultAudioId.value ? [defaultAudioId.value] : []
}

function setDefaultAudio(a: AudioView) {
  if (a.embedded) return
  if (!audioIds.value.includes(a.id)) audioIds.value.push(a.id)
  preferredAudioId.value = a.id
}

function toggleAudio(a: AudioView) {
  if (a.embedded) return
  const set = new Set(audioIds.value)
  if (set.has(a.id) && set.size === 1) {
    toast('至少选择一条音轨')
    return
  }
  set.has(a.id) ? set.delete(a.id) : set.add(a.id)
  audioIds.value = [...set]
  reconcileDefaultAudio()
}

async function loadTmdb() {
  const v = d.value
  if (!v || !store.state?.settings.tmdbKey || !canMatchTmdb.value) return
  const seq = ++tmdbSeq
  tmdbLoading.value = true
  tmdbError.value = ''
  try {
    const hits = await gvs('tmdbSearch', v.title, v.kind !== 'movie')
    if (seq !== tmdbSeq || d.value !== v) return
    tmdbHits.value = hits
    selectTmdb(defaultTmdbHit(manualKind.value ? hits.filter(h => h.kind === v.kind) : hits, v.title, v.year, v.kind))
  } catch (e) {
    if (seq === tmdbSeq) tmdbError.value = errText(e)
  } finally {
    if (seq === tmdbSeq) tmdbLoading.value = false
  }
}

onUnmounted(() => { ++tmdbSeq; ++seasonsSeq; ++namingSeq })

watch(tmdb, () => {
  ++seasonsSeq
  seasons.value = []
  selectedSeason.value = ''
  seasonsLoading.value = false
  seasonsError.value = ''
  seasonsWarning.value = ''
  if (tmdb.value?.kind === 'show') void loadSeasons()
}, { flush: 'sync' })

async function loadSeasons() {
  const hit = tmdb.value
  if (!hit || hit.kind !== 'show') return
  const seq = ++seasonsSeq
  seasonsLoading.value = true
  seasonsError.value = ''
  seasonsWarning.value = ''
  try {
    const result = await gvs('tmdbSeasons', hit.id)
    if (seq !== seasonsSeq || tmdb.value !== hit) return
    const rows = [...result.seasons]
    const previous = selectedSeasonRow.value
    if (previous && !rows.some(row => seasonKey(row) === selectedSeason.value)) {
      if (result.warning) rows.push(previous)
      else {
        selectedSeason.value = ''
        toast('所选季号已不在 TMDB 列表，已改为沿用平台季号')
      }
    }
    seasons.value = rows
    seasonsWarning.value = result.warning
  } catch (e) {
    if (seq === seasonsSeq) seasonsError.value = errText(e)
  } finally {
    if (seq === seasonsSeq) seasonsLoading.value = false
  }
}

const seasonCode = (number: number) => `S${String(number).padStart(2, '0')}`
const seasonLabel = (season: TmdbSeason) => [season.name, seasonCode(season.number), season.episodeCount ? `${season.episodeCount} 集` : '', season.airDate.slice(0, 4)].filter(Boolean).join(' · ')
const seasonKey = (season: TmdbSeason) => season.groupId ? `${season.groupId}:${season.number}` : String(season.number)
const selectedSeasonRow = computed(() => seasons.value.find(season => seasonKey(season) === selectedSeason.value))
const seasonLists = computed(() => {
  const lists = new Map<string, { key: string; label: string; seasons: TmdbSeason[] }>()
  for (const season of seasons.value) {
    const key = season.groupId || 'ordinary'
    let list = lists.get(key)
    if (!list) {
      list = { key, label: season.groupId ? `剧集分组：${season.groupName}` : '普通季列表', seasons: [] }
      lists.set(key, list)
    }
    list.seasons.push(season)
  }
  return [...lists.values()]
})

function setKind(kind: 'movie' | 'show') {
  const v = d.value
  if (!v) return
  v.kind = kind
  v.pickNoun = kind === 'movie' ? '个版本' : '集'
  if (tmdb.value && tmdb.value.kind !== kind) tmdb.value = null
}

function selectTmdb(hit: TmdbHit | null) {
  if (hit) setKind(hit.kind)
  tmdb.value = hit
  tmdbOpen.value = false
}

function changeKind(kind: 'movie' | 'show') {
  // The user's choice must not be reversed by an earlier automatic lookup.
  manualKind.value = true
  setKind(kind)
}

const request = computed<EnqueueRequest | null>(() => {
  const v = d.value
  const p = probe.value
  if (!v || !p) return null
  return {
    token: p.token,
    detail: { provider: v.provider, id: v.id, title: v.title, year: v.year, kind: v.kind, poster: v.poster },
    episodes: store.probeEpisodes.map((e) => ({ ...e, languages: e.languages.map((l) => ({ ...l })) })),
    quality: qIndex.value,
    audioIds: [...audioIds.value],
    ...(subtitles.value.length ? { subtitleIds: [...subtitleIds.value] } : {}),
    defaultAudioId: preferredAudioId.value || undefined,
    tmdb: tmdb.value ? { ...tmdb.value } : null,
    tmdbSeason: tmdb.value?.kind === 'show' ? selectedSeasonRow.value?.number : undefined,
    accountId: store.accountPick[v.provider] || undefined,
  }
})

let namingSeq = 0
watch(
  [request, () => store.state?.settings.includeEpisodeTitle],
  async ([r]) => {
    const seq = ++namingSeq
    if (!r) return (naming.value = null)
    try {
      const n = await gvs('namingPreview', r)
      if (seq === namingSeq) naming.value = n // 丢弃先发后到的旧结果
    } catch {
      if (seq === namingSeq) naming.value = null
    }
  },
  { immediate: true },
)

const totalSize = computed(() => (quality.value?.size ?? 0) * store.probeEpisodes.length)
const hasDts = computed(() => audios.value.some((a) => audioIds.value.includes(a.id) && /dts/i.test(a.codec + a.label + a.id)))
const count = computed(() => store.probeEpisodes.length)
const noun = computed(() => isMovie.value ? '个版本' : '集')
const canStart = computed(() => !starting.value && !store.probing && !store.probeError && !!request.value?.episodes.length && !!quality.value && !tmdbLoading.value)

async function start() {
  const r = request.value
  if (!canStart.value || !r) return
  starting.value = true
  try {
    const n = await gvs('enqueue', r)
    toast(`已加入 ${n} 个下载任务`, 'ok')
    go('downloads')
  } catch (e) {
    toast(errText(e), 'err')
  } finally {
    starting.value = false
  }
}

defineExpose({ start, canStart, starting })

const spec = (q: { width: number; height: number; size: number; fps: number }) =>
  [q.width && q.height ? `${q.width}×${q.height}` : '', q.fps ? `${q.fps}帧` : '', q.size ? `${isMovie.value ? '' : '每集'}约 ${human(q.size)}` : '']
    .filter(Boolean)
    .join(' · ')
const CODEC_NAME: Record<string, string> = { bytevc1: 'H.265', bytevc2: 'H.266', h264: 'H.264', avc: 'H.264', h265: 'H.265', hevc: 'H.265', av1: 'AV1' }
const renditionSize = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes > 0 ? `${(bytes / 1024 ** 2).toFixed(2)} MB` : '源站未提供'
/** 咪咕 App 每档是独立文件：显示源站给的时长 hh:mm:ss */
const renditionDuration = (sec?: number) => sec ? [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), Math.floor(sec % 60)].map((n) => String(n).padStart(2, '0')).join(':') : '源站未提供'
/** 码流名给人看：红果的 id 是「1080p|bytevc1|」这种拼接串，去掉空段和标题里已有的部分，编码换成通用名 */
function streamCode(q: { stream: string; label: string }): string {
  if (d.value?.provider === 'iqcn') return ''
  // 咪咕 App 的码流串含内部档位/用户编号（u121417|b1810…），编码与分辨率已单独成列，不展示
  if (miguApp.value) return ''
  if (d.value?.provider === 'bilibili') return CODEC_NAME[q.stream.split('|')[1]?.toLowerCase() || ''] || ''
  const label = q.label.toLowerCase()
  const parts = q.stream.split('|').map((t) => t.trim()).filter((t) => t && !label.includes(t.toLowerCase()))
  return [...new Set(parts.map((t) => CODEC_NAME[t.toLowerCase()] ?? t))].join(' · ')
}
/** 同是「4K · 60fps」的几档靠码流名区分：杜比视界 / HDR / SDR */
function range(q: { stream: string; hdr: string; label: string }): string {
  const t = `${q.stream} ${q.hdr}`.toLowerCase()
  if (/dolbyvision|dvhe|dvh1|(^|_)dv(_|$)/.test(t)) return '杜比视界'
  if (/hdr10/.test(t)) return 'HDR10'
  if (/vivid/.test(t)) return 'HDR Vivid'
  if (/hdr/.test(t)) return 'HDR'
  if (/sdr/.test(t)) return 'SDR'
  return ''
}
function qname(q: { stream: string; hdr: string; label: string }): string {
  const r = range(q)
  return r && !q.label.includes(r) ? `${r} · ${q.label}` : q.label
}
const sep = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/')
const tmpFull = computed(() => store.state?.settings.tmpDir || '')
const tmpText = computed(() => (tmpFull.value ? sep(tmpFull.value) : '下载目录同盘 .gvs-tmp'))

/* ---- 卡片展示用的规格 ---- */
const vRes = (q: { height: number; width: number }) => resolutionTier(q.height, q.width)
const vCodec = (q: { codec: string; stream: string }) => videoCodec(q.codec, q.stream)
const vHdr = (q: { hdr: string; stream: string; label: string }) => hdrKind(q.hdr, q.stream, q.label) || range(q)
const aCodec = (a: AudioView) => audioCodec(a.codec, a.label)
const aCh = (a: AudioView) => audioChannels(a.label, a.codec)

/* ---- 规则组匹配预览：订阅里的规则优先，否则用默认规则 ---- */
const ruleSub = computed(() => (d.value ? subscriptionOf(d.value.provider, d.value.id) : null))
const ruleText = computed(() => ruleSub.value?.rules || DEFAULT_RULES)
const ruleGroup = computed(() => parseRules(ruleText.value))
const ruleCands = computed<RuleCandidate[]>(() => (probe.value?.qualities ?? []).map((q) => ({
  index: q.index, height: q.height, width: q.width, codec: `${q.codec} ${q.stream}`, hdr: vHdr(q), label: q.label, size: q.size, fps: q.fps,
  audios: (q.audios.length ? q.audios : probe.value?.audios ?? []).map((a) => ({ id: a.id, label: a.label, codec: a.codec, lang: a.lang })),
})))
const ruleMatch = computed(() => (ruleCands.value.length ? pickBest(ruleGroup.value, ruleCands.value) : null))
const ruleQuality = computed(() => probe.value?.qualities.find((q) => q.index === ruleMatch.value?.index) ?? null)
const ruleApplied = computed(() => {
  const m = ruleMatch.value
  if (!m || m.index !== qIndex.value) return false
  return m.audioIds.every((id) => audioIds.value.includes(id) || audios.value.some((a) => a.id === id && a.embedded))
})
const tierText = (i: number) => ruleGroup.value.tiers[i]?.map((t) => (t.neg ? '!' : '') + t.key.toUpperCase().replace('ANY', '任意')).join(' & ') ?? ''
async function applyRule() {
  const m = ruleMatch.value
  if (!m) return
  qIndex.value = m.index
  await nextTick() // 让 qIndex 的 watcher 先按新画质重置音轨，再叠加规则选中的音轨
  const ids = m.audioIds.filter((id) => audios.value.some((a) => a.id === id && !a.embedded))
  if (ids.length) {
    audioIds.value = ids
    reconcileDefaultAudio()
  }
}
</script>


<template>
  <div ref="panel" class="page qpage" :class="{ 'quality-page': !embedded && (store.probing || (probe && !store.probeError)), embedded }">
    <button v-if="!embedded" type="button" class="back" @click="back('detail')"><Icon name="back" :size="16" />{{ d?.title ?? '返回' }}</button>
    <div class="h1-row">
      <h1 v-if="!embedded" class="h1">选择画质</h1>
      <h2 v-else class="h2s">画质与音轨</h2>
      <span class="muted">已选 {{ count }} {{ noun }}<template v-if="count > 1"> · 按{{ isMovie ? '首个版本' : '第一集' }}探测，整批沿用</template></span>
    </div>

    <div v-if="store.probing" class="qbody">
      <div class="qmain">
        <section class="qsec">
          <div class="qsec-h"><Icon name="movie" :size="16" /><span>视频</span><span class="muted small row"><span class="spin" />正在向平台取画质…</span></div>
          <div class="vgrid">
            <div v-for="i in 4" :key="i" class="vcard sk"><Skeleton w="64" h="28" r="7" /><Skeleton w="70%" h="14" /><Skeleton w="50%" h="12" /></div>
          </div>
        </section>
        <section class="qsec">
          <div class="qsec-h"><Icon name="volume" :size="16" /><span>音轨</span></div>
          <div class="agrid">
            <div v-for="i in 3" :key="i" class="acard sk"><Skeleton w="48" h="14" /><Skeleton w="80%" h="16" /></div>
          </div>
        </section>
      </div>
      <aside class="qside">
        <div class="card side-card"><Skeleton w="72" h="13" /><Skeleton w="100%" h="38" r="8" /><Skeleton w="100%" h="58" r="8" /></div>
      </aside>
    </div>
    <div v-else-if="store.probeError" class="error-box">
      取画质失败：{{ store.probeError }}
      <div style="margin-top: 10px"><button type="button" class="btn sm" @click="openQuality">重试</button></div>
    </div>
    <template v-else-if="probe">
      <div class="qbody">
        <div class="qmain">
          <div v-if="probe.warning" class="warn-box">{{ probe.warning }}</div>
          <div v-if="probe.vip?.hasTrial" class="warn-box">当前账号只能拿到试看片段，完整版需要会员登录</div>

          <div class="toprow">
            <div v-if="d && accountsOf(d.provider).length > 1" class="card mini">
              <span class="mini-h"><Icon name="user" :size="14" />下载账号</span>
              <AccountPicker :provider="d.provider" label="" @change="openQuality()" />
            </div>
            <div class="card mini rulecard" :class="{ hit: ruleApplied }">
              <span class="mini-h"><Icon name="rules" :size="14" />规则组匹配<span class="muted small">{{ ruleSub ? '来自订阅' : '默认规则' }}</span></span>
              <div class="tiers" :aria-label="ruleText">
                <template v-for="(_, i) in ruleGroup.tiers" :key="i">
                  <span v-if="i" class="tsep">›</span>
                  <span class="tier" :class="{ on: ruleMatch?.tier === i }">{{ tierText(i) }}</span>
                </template>
              </div>
              <div class="rule-res">
                <template v-if="ruleMatch && ruleQuality">
                  <span>命中第 {{ ruleMatch.tier + 1 }} 档 · <b>{{ qname(ruleQuality) }}</b></span>
                  <span v-if="ruleApplied" class="chip ok"><Icon name="check" :size="12" :stroke="3" />已采用</span>
                  <button v-else type="button" class="btn sm primary" @click="applyRule">按规则选择</button>
                </template>
                <span v-else class="muted">没有画质满足规则，可手动选择</span>
              </div>
            </div>
          </div>

          <div v-if="!manual" class="card autosum">
            <span class="lab">已按默认规则自动选择</span>
            <div class="arow"><span class="muted">视频</span><b>{{ quality ? qname(quality) : '—' }}</b><span class="dim small">{{ quality ? spec(quality) : '' }}</span></div>
            <div class="arow"><span class="muted">音轨</span><b>{{ embeddedOnly ? '随视频内嵌' : audioSummary || '—' }}</b></div>
            <span class="muted small">默认画质：{{ { best: '最高可用', '2160': '不超过 4K', '1080': '不超过 1080P', '720': '不超过 720P' }[prefs().defaultQuality] }}（可在设置里修改）</span>
            <button type="button" class="btn sm" @click="manual = true">手动选择画质 / 音轨<Icon name="down" :size="14" /></button>
          </div>
          <template v-else>
            <button v-if="embedded" type="button" class="linkish collapse-btn" @click="manual = false"><Icon name="up" :size="14" />收起手动选择</button>
            <fieldset class="qsec fs video-options">
              <legend class="qsec-h"><Icon name="movie" :size="16" /><span>视频画质</span><span class="muted small">{{ probe.qualities.length }} 档</span></legend>
              <div class="vgrid stagger">
                <label
                  v-for="q in probe.qualities" :key="q.index" class="vcard opt" :class="{ on: q.index === qIndex, rule: ruleMatch?.index === q.index, migu: miguApp }"
                  :aria-label="miguApp ? `${q.label} · ${CODEC_NAME[q.codec.toLowerCase()] || q.codec} · ${q.width}×${q.height} · ${human(q.size)}` : undefined"
                >
                  <input v-model="qIndex" type="radio" name="quality" :value="q.index" class="sr-only" />
                  <span class="vtop">
                    <span v-if="miguApp" class="mono muted idx" title="序号">#{{ q.index + 1 }}</span>
                    <span class="res">{{ vRes(q) }}</span>
                    <span v-if="vHdr(q)" class="hdr" :class="{ dv: vHdr(q) === '杜比视界' }">{{ vHdr(q) }}</span>
                    <span class="radio"><span v-if="q.index === qIndex" /></span>
                  </span>
                  <span class="on-t" :title="qname(q)">{{ qname(q) }}</span>
                  <span v-if="miguApp" class="vspec">
                    <span class="mono" title="视频编码">{{ CODEC_NAME[q.codec.toLowerCase()] || q.codec || '未知' }}</span>
                    <span class="mono" title="分辨率">{{ q.width && q.height ? `${q.width}×${q.height}` : '未知' }}</span>
                    <span class="mono" title="影片时长">{{ renditionDuration(q.duration) }}</span>
                  </span>
                  <span v-else class="vspec">
                    <span v-if="vCodec(q)" class="mono">{{ vCodec(q) }}</span>
                    <span v-if="q.width && q.height" class="mono">{{ q.width }}×{{ q.height }}</span>
                    <span v-if="q.fps" class="mono">{{ q.fps }}帧</span>
                  </span>
                  <span class="vfoot">
                    <span v-if="miguApp" class="size mono" title="文件体积">{{ renditionSize(q.size) }}</span>
                    <span v-else class="size mono">{{ q.size ? `${isMovie ? '' : '每集 '}≈ ${human(q.size)}` : '大小未知' }}</span>
                    <span v-if="streamCode(q)" class="mono muted code">{{ streamCode(q) }}</span>
                    <span v-if="ruleMatch?.index === q.index" class="rtag">规则推荐</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <section class="qsec">
              <div class="qsec-h">
                <Icon name="volume" :size="16" /><span>音轨</span>
                <span v-if="!embeddedOnly && audios.length" class="muted small">已选 {{ pickedCount }} / {{ audios.length }}</span>
                <span v-if="!embeddedOnly && audios.length && d?.provider !== 'iqcn'" class="aq">
                  <button type="button" class="linkish" @click="pickAll">全选</button>
                  <button type="button" class="linkish" @click="pickDefault">只要默认</button>
                </span>
              </div>
              <div v-if="embeddedOnly" class="card note"><Icon name="info" :size="15" />随视频内嵌{{ embeddedNote ? `：${embeddedNote}` : '，无需选择' }}</div>
              <div v-else-if="!audios.length" class="card note"><Icon name="info" :size="15" />平台没有返回独立音轨</div>
              <IQCNAudioPicker v-else-if="d?.provider === 'iqcn'" class="card iqcn" :audios="audios" :selected-ids="audioIds" :default-id="defaultAudioId"
                @toggle="toggleAudio" @set-default="setDefaultAudio" @all="pickAll" @only-default="pickDefault" />
              <fieldset v-else class="fs">
                <legend class="sr-only">音轨</legend>
                <div class="agrid stagger">
                  <div v-for="a in audios" :key="a.id" class="acard" :class="{ on: audioIds.includes(a.id) || a.embedded, def: defaultAudioId === a.id }">
                    <label class="achip" :class="{ dis: a.embedded }" :title="a.embedded ? '已内嵌在视频里' : a.codec">
                      <input type="checkbox" class="sr-only" :checked="audioIds.includes(a.id) || a.embedded"
                        :disabled="a.embedded || (audioIds.length === 1 && audioIds.includes(a.id))" @change="toggleAudio(a)" />
                      <span class="cbox"><Icon v-if="audioIds.includes(a.id) || a.embedded" name="check" :size="12" :stroke="3" /></span>
                      <span class="alang">{{ a.lang || '音轨' }}</span>
                      <span class="alabel">{{ a.label }}</span>
                      <span class="aspec">
                        <span v-if="aCodec(a)" class="mono">{{ aCodec(a) }}</span>
                        <span v-if="aCh(a)" class="mono">{{ aCh(a) }}</span>
                        <span v-if="a.embedded" class="muted">内嵌</span>
                        <span v-if="a.audioDescription" class="rtag">口述影像</span>
                      </span>
                    </label>
                    <button v-if="!a.embedded" type="button" class="audio-default" :class="{ active: defaultAudioId === a.id }"
                      :aria-pressed="defaultAudioId === a.id" :aria-label="`${a.lang} ${a.label} ${defaultAudioId === a.id ? '默认播放' : '设为默认'}`"
                      title="下载后默认播放这条音轨" @click="setDefaultAudio(a)">
                      {{ defaultAudioId === a.id ? '默认播放' : '设为默认' }}
                    </button>
                  </div>
                </div>
              </fieldset>
              <div v-if="d?.provider === 'iq'" class="muted small">初始只选平台默认语言的音轨，其他配音可手动选择。</div>
              <div v-if="!embeddedOnly && audios.length" class="muted small">已选音轨默认优先 DTS，其次杜比 / 全景声，再选 AAC；也可手动指定，整批下载沿用此选择。</div>
              <div v-if="hasDts" class="muted small">选了 DTS 音轨，会用 MP4Box 封装成 MP4</div>
              <div v-if="hasDts && d?.provider === 'youku' && !preferredAudioId" class="muted small">封装时若确认 DTS:X 为 10 声道，会优先将已选的 DDP 5.1 设为默认播放。</div>
            </section>

            <section class="qsec">
              <div class="qsec-h"><Icon name="cc" :size="16" /><span>字幕</span></div>
              <div v-if="subtitles.length" class="agrid">
                <div v-for="s in subtitles" :key="s.id" class="acard" :class="{ on: subtitleIds.includes(s.id), def: s.isDefault }">
                  <label class="achip" :title="s.forced ? '强制字幕：只翻译外语对白 / 画面文字' : s.sdh ? 'SDH：含音效描述，供听障观众' : s.lang">
                    <input type="checkbox" class="sr-only" :checked="subtitleIds.includes(s.id)" @change="toggleSubtitle(s.id)" />
                    <span class="cbox"><Icon v-if="subtitleIds.includes(s.id)" name="check" :size="12" :stroke="3" /></span>
                    <span class="alang">{{ s.label }}</span>
                    <span class="alabel">{{ [s.lang, s.forced ? '强制' : '', s.sdh ? 'SDH' : '', s.isDefault ? '默认显示' : ''].filter(Boolean).join(' · ') }}</span>
                  </label>
                </div>
              </div>
              <span v-if="subtitles.length" class="muted small">已选 {{ subtitleIds.length }} / {{ subtitles.length }} 条字幕；按源站原格式（ASS / VTT / SRT）挂成独立轨，写入语言、轨名与默认标记。默认勾选简体中文，没有则繁体、再没有则英语。</span>
              <div v-else class="agrid">
                <div class="acard on sub-card">
                  <span class="achip dis"><span class="cbox"><Icon name="check" :size="12" :stroke="3" /></span><span class="alang">跟随视频</span><span class="alabel">平台内嵌 / 硬字幕</span></span>
                </div>
              </div>
              <span v-if="!subtitles.length" class="muted small">该平台没有返回可单独下载的字幕轨，字幕随视频画面保留。</span>
            </section>
          </template>
        </div>

        <aside class="qside">
          <div class="card side-card">
            <h3 class="side-h">输出</h3>
            <details class="output-options" :open="!embedded"><summary>命名与刮削</summary><div class="output-options-body">

          <div v-if="canMatchTmdb" class="blk">
            <span class="lab">内容类型</span>
            <div class="kind-options" role="group" aria-label="内容类型">
              <button type="button" class="btn sm" :class="{ primary: isMovie }" :aria-pressed="isMovie" @click="changeKind('movie')">电影</button>
              <button type="button" class="btn sm" :class="{ primary: !isMovie }" :aria-pressed="!isMovie" @click="changeKind('show')">剧集</button>
            </div>
          </div>

          <div v-if="store.state?.settings.tmdbKey && canMatchTmdb" class="blk">
            <span class="lab">TMDB 匹配</span>
            <div v-if="tmdbLoading" class="dim small row"><span class="spin" />正在查 TMDB…</div>
            <div v-else-if="tmdbError" class="warn-box">TMDB：{{ tmdbError }} <button type="button" class="linkish" @click="loadTmdb">重试</button></div>
            <template v-else>
              <div class="match" :class="{ none: !tmdb }">
                <Icon v-if="tmdb" name="check" :size="16" :stroke="2.5" />
                <span>{{ tmdb ? `${tmdb.name}${tmdb.year ? ` (${tmdb.year})` : ''}` : tmdbHits.length ? '不使用 TMDB' : '未找到 TMDB 条目' }}</span>
                <button v-if="tmdbHits.length" type="button" class="linkish" @click="tmdbOpen = !tmdbOpen">{{ tmdbOpen ? '收起' : '更换' }}</button>
                <button v-else type="button" class="linkish" @click="loadTmdb">重试</button>
              </div>
              <div v-if="tmdbOpen" class="hits">
                <button v-for="h in tmdbHits" :key="`${h.kind}:${h.id}`" type="button" class="hit" :class="{ on: tmdb?.id === h.id && tmdb?.kind === h.kind }" @click="selectTmdb(h)">
                  {{ h.name }}<span class="muted">{{ h.kind === 'movie' ? '电影' : '剧集' }} {{ h.year || '' }}</span>
                </button>
                <button type="button" class="hit" :class="{ on: !tmdb }" @click="selectTmdb(null)">不使用 TMDB</button>
              </div>
            </template>
          </div>

          <div v-if="tmdb?.kind === 'show'" class="blk">
            <label for="tmdb-season" class="lab">输出季号</label>
            <div v-if="seasonsLoading" class="dim small row"><span class="spin" />正在读取 TMDB 季列表…</div>
            <div v-else-if="seasonsError" class="warn-box">季列表：{{ seasonsError }} <button type="button" class="linkish" @click="loadSeasons">重试</button></div>
            <div v-else-if="seasonsWarning" class="warn-box">{{ seasonsWarning }} <button type="button" class="linkish" @click="loadSeasons">重试</button></div>
            <select id="tmdb-season" v-model="selectedSeason" class="season-select" :disabled="seasonsLoading">
              <option :value="''">沿用平台季号</option>
              <optgroup v-for="list in seasonLists" :key="list.key" :label="list.label">
                <option v-for="season in list.seasons" :key="seasonKey(season)" :value="seasonKey(season)">{{ seasonLabel(season) }}</option>
              </optgroup>
            </select>
            <span class="small muted">整批使用所选季号，集号沿用平台；目录和文件名预览同步更新。</span>
            <span v-if="selectedSeasonRow?.groupId" class="small muted">采用「{{ selectedSeasonRow.groupName }}」分组，保留平台集号，不换算总集数。</span>
            <span v-if="!seasonsLoading && !seasonsError && !seasons.length" class="small muted">TMDB 暂无季列表，可沿用平台季号下载。</span>
          </div>

          <div v-if="naming" class="blk">
            <span class="lab">文件名预览</span>
            <div class="name mono">{{ sep(naming.folder) }}/<br /><span>{{ naming.file }}</span></div>
            <span v-if="naming.note" class="small muted">{{ naming.note }}</span>
          </div>

          </div></details>
            <button type="button" class="dir mono" :title="store.state?.settings.outDir" @click="openSettings('download')">
              <Icon name="folder" :size="16" />{{ store.state?.settings.outDir }}
            </button>
            <button type="button" class="dir mono tmp" :title="tmpFull" @click="openSettings('download')">
              <Icon name="file" :size="16" />临时文件：{{ tmpText }}
            </button>
          </div>
        </aside>
      </div>

      <Teleport :to="footerTarget || 'body'" :disabled="!footerTarget">
        <div class="actionbar" :class="{ docked: footerTarget }">
          <div class="selection-summary">
            <strong>{{ quality ? qname(quality) : '请选择画质' }}</strong>
            <span class="muted small">{{ audioSummary || embeddedNote || '随视频音轨' }} · {{ count }} {{ noun }} · 整批沿用当前选择</span>
          </div>
          <div v-if="totalSize" class="sum"><span class="dim">预计占用</span><span class="mono">约 {{ human(totalSize) }}</span></div>
          <button type="button" class="btn primary big" :disabled="!canStart" @click="start">
            <span v-if="starting" class="spin" /><Icon v-else name="download" />开始下载 {{ count }} {{ noun }}
          </button>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.qpage { position: relative; }
.quality-page { overflow: visible; }
.page.embedded { height: auto; flex-shrink: 0; overflow: visible; scroll-margin-top: 16px; padding: 20px 22px; border: 1px solid var(--line); border-radius: var(--ui-radius-lg, 16px); background: var(--card); }
.page.embedded .h1-row { gap: 12px; }
.h2s { font-size: 18px; font-weight: 900; }
.back { margin-bottom: -8px; }
.small { font-size: 12.5px; font-weight: 400; }
.row { display: flex; align-items: center; gap: 8px; }
.qbody { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.qmain { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.qside { position: sticky; top: 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.toprow { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.mini { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.mini :deep(.ap > svg), .mini :deep(.ap > .muted:empty) { display: none; }
.mini-h { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 850; }
.mini-h .muted { margin-left: auto; font-weight: 600; }
.rulecard { transition: border-color var(--ui-duration-base, .2s), box-shadow var(--ui-duration-base, .2s); }
.rulecard.hit { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.tiers { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tier { height: 24px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; font-weight: 700; color: var(--ink-3); display: inline-flex; align-items: center; font-family: var(--font-mono, ui-monospace); }
.tier.on { color: var(--on-orange); background: var(--orange); border-color: var(--orange); box-shadow: var(--ui-glow); }
.tsep { color: var(--ink-3); }
.rule-res { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.rule-res .btn, .rule-res .chip { margin-left: auto; }
.autosum { padding: 18px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.autosum .lab { font-size: 13px; font-weight: 800; color: var(--orange-text); }
.arow { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.arow .muted { width: 36px; }
.collapse-btn { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; }
.fs { margin: 0; padding: 0; border: 0; min-width: 0; }
.qsec { display: flex; flex-direction: column; gap: 10px; min-width: 0; margin: 0; padding: 0; border: 0; }
.qsec-h { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 900; padding: 0; width: 100%; }
.aq { margin-left: auto; display: flex; gap: 12px; }
/* Keep hidden inputs inside their visible labels so focusing them scrolls the quality list. */
.opt, .achip { position: relative; }
.vgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.vcard {
  padding: 14px 14px 12px; border-radius: var(--ui-radius-md, 11px); border: 1.5px solid var(--line); background: var(--raised); display: flex; flex-direction: column; gap: 8px; cursor: pointer; min-width: 0;
  transition: border-color var(--ui-duration-fast, .12s), transform var(--ui-duration-fast, .12s), box-shadow var(--ui-duration-base, .2s), background var(--ui-duration-fast, .12s);
}
.vcard:hover { border-color: var(--line-2); transform: translateY(-2px); }
.vcard.on { border-color: var(--orange); background: var(--orange-soft); box-shadow: 0 10px 28px -16px rgb(var(--ui-accent-channel, 208 135 0) / 70%); }
.vcard:focus-within { outline: 2px solid var(--orange); outline-offset: 2px; }
.vcard.sk { cursor: default; }
.vtop { display: flex; align-items: center; gap: 8px; }
.idx { font-size: 12px; font-weight: 700; }
.res { font-family: var(--font-display); font-size: 18px; font-weight: 800; letter-spacing: -.2px; line-height: 1.2; }
.vcard.on .res { color: var(--orange-text); }
.hdr { height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11px; font-weight: 850; display: inline-flex; align-items: center; color: var(--orange-text); border: 1px solid color-mix(in srgb, var(--orange) 40%, var(--line)); }
.hdr.dv { color: #fff; border: 0; background: linear-gradient(135deg, #7c3aed, #a78bfa); }
.radio { margin-left: auto; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line-2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.vcard.on .radio { border-color: var(--orange); }
.radio span { width: 8px; height: 8px; border-radius: 50%; background: var(--orange); }
.on-t { font-size: 13.5px; font-weight: 700; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.vspec, .aspec { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11.5px; color: var(--ink-2); }
.vspec > span, .aspec > span { padding: 1px 6px; border-radius: 5px; background: color-mix(in srgb, var(--ink) 6%, transparent); }
.vfoot { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
.size { font-weight: 700; }
.code { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.rtag { margin-left: auto; flex-shrink: 0; font-size: 10.5px; font-weight: 850; color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--line)); border-radius: 999px; padding: 0 6px; }
.agrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.acard { padding: 12px 14px; border-radius: var(--ui-radius-md, 11px); border: 1.5px solid var(--line); background: var(--raised); display: flex; flex-direction: column; gap: 10px; min-width: 0; transition: border-color var(--ui-duration-fast, .12s), background var(--ui-duration-fast, .12s); }
.acard:hover { border-color: var(--line-2); }
.acard.on { border-color: color-mix(in srgb, var(--orange) 70%, var(--line)); background: var(--orange-soft); }
.acard.sk { gap: 8px; }
.achip { display: grid; grid-template-columns: auto 1fr; grid-template-areas: "box lang" ". label" ". spec"; column-gap: 10px; row-gap: 3px; cursor: pointer; user-select: none; min-width: 0; }
.achip.dis { cursor: default; }
.achip:focus-within { outline: 2px solid var(--orange); outline-offset: 2px; border-radius: 6px; }
.cbox { grid-area: box; width: 18px; height: 18px; border-radius: 5px; border: 2px solid var(--line-2); display: flex; align-items: center; justify-content: center; color: var(--on-orange); margin-top: 1px; }
.acard.on .cbox { background: var(--orange); border-color: var(--orange); }
.alang { grid-area: lang; font-size: 12px; font-weight: 800; color: var(--ink-2); }
.alabel { grid-area: label; font-size: 14px; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aspec { grid-area: spec; }
.audio-default { align-self: flex-start; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; background: transparent; color: var(--ink-2); font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.audio-default:hover { border-color: var(--line-2); color: var(--ink); }
.audio-default.active { border-color: var(--orange); background: var(--orange); color: var(--on-orange); font-weight: 800; }
.audio-default:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }
.note { padding: 12px 14px; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
.iqcn { padding: 14px 16px; }
.side-card { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.side-h { font-size: 15px; font-weight: 900; }
.kind-options { display: flex; gap: 8px; }
.season-select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); font: inherit; font-size: 14px; }
.season-select:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }
.output-options > summary { cursor: pointer; font-size: 13px; font-weight: 700; color: var(--ink-2); padding: 4px 0; }
.output-options-body { display: flex; flex-direction: column; gap: 16px; padding: 10px 0 2px; }
.blk { display: flex; flex-direction: column; gap: 6px; }
.lab { font-size: 13px; color: var(--ink-3); }
.match { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--ok-bg); color: var(--ok); border-radius: 8px; font-size: 14px; font-weight: 500; }
.match.none { background: var(--paper-2); color: var(--ink-2); }
.match .linkish { margin-left: auto; }
.hits { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.hit { padding: 9px 12px; border: 0; border-bottom: 1px solid var(--line); background: var(--card); color: var(--ink); text-align: left; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; font-size: 14px; }
.hit:last-child { border-bottom: 0; }
.hit:hover, .hit.on { background: var(--paper-2); }
.name { padding: 10px 12px; background: var(--ui-input); border: 1px solid var(--line); color: var(--ink-2); border-radius: 8px; font-size: 12px; line-height: 1.7; word-break: break-all; }
.name span { color: var(--orange); }
.dir { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--ink-2); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; word-break: break-all; }
.dir:hover { color: var(--orange-text); }
.tmp { color: var(--ink-3); font-size: 12px; }
/* 详情页使用独立底栏；独立画质页沿用吸底操作条。 */
.actionbar {
  position: sticky; bottom: 0; z-index: 5; margin: 18px -22px 0; padding: 14px 22px 18px; display: flex; align-items: center; gap: 18px;
  background: color-mix(in srgb, var(--card) 90%, transparent); backdrop-filter: blur(14px); border-top: 1px solid var(--line);
  border-radius: 0 0 var(--ui-radius-lg, 16px) var(--ui-radius-lg, 16px);
}
.page:not(.embedded) .actionbar { margin: 18px 0 0; border: 1px solid var(--line); border-radius: var(--ui-radius-lg, 16px); bottom: 0; box-shadow: var(--ui-shadow-surface); }
.actionbar.docked { position: static; margin: 0; padding: 12px 20px; background: var(--card); backdrop-filter: none; border: 1px solid var(--line); border-radius: var(--ui-radius-lg, 16px); }
.selection-summary { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.selection-summary strong { font-size: 15px; font-weight: 850; }
.selection-summary .small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sum { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 13px; flex-shrink: 0; }
.sum .mono { font-size: 15px; font-weight: 800; }
.actionbar .btn.big { flex-shrink: 0; min-width: 200px; border-radius: 11px; }
@media (max-width: 1180px) {
  .qbody { grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; }
}
@media (max-width: 980px) {
  .qbody { grid-template-columns: 1fr; }
  .qside { position: static; }
  .actionbar { flex-wrap: wrap; }
}
</style>
