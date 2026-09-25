<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AudioView, EnqueueRequest, NamingPreview, TmdbHit } from '@shared/api'
import Icon from '../components/Icon.vue'
import { back, errText, go, gvs, human, openQuality, store, toast } from '../store'

const d = computed(() => store.detail)
const probe = computed(() => store.probe)
const qIndex = ref(0)
const audioIds = ref<string[]>([])
const tmdb = ref<TmdbHit | null>(null)
const tmdbHits = ref<TmdbHit[]>([])
const tmdbLoading = ref(false)
const tmdbError = ref('')
const tmdbOpen = ref(false)
const naming = ref<NamingPreview | null>(null)
const starting = ref(false)

const quality = computed(() => probe.value?.qualities[qIndex.value] ?? null)
const audios = computed<AudioView[]>(() => {
  const q = quality.value
  if (q && q.audios.length) return q.audios
  return probe.value?.audios ?? []
})

function defaultAudios() {
  const list = audios.value
  const pre = list.filter((a) => a.selected || a.embedded).map((a) => a.id)
  audioIds.value = pre.length ? pre : list.filter((a) => a.isDefault).slice(0, 1).map((a) => a.id)
}

watch(
  probe,
  (p) => {
    qIndex.value = 0
    tmdb.value = null
    tmdbHits.value = []
    tmdbError.value = ''
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
const pickedCount = computed(() => audios.value.filter((a) => a.embedded || audioIds.value.includes(a.id)).length)
function pickAll() {
  audioIds.value = audios.value.filter((a) => !a.embedded).map((a) => a.id)
}
function pickDefault() {
  audioIds.value = audios.value.filter((a) => a.isDefault && !a.embedded).slice(0, 1).map((a) => a.id)
}

function toggleAudio(a: AudioView) {
  if (a.embedded) return
  const set = new Set(audioIds.value)
  set.has(a.id) ? set.delete(a.id) : set.add(a.id)
  audioIds.value = [...set]
}

async function loadTmdb() {
  const v = d.value
  if (!v || !store.state?.settings.tmdbKey || (v.provider !== 'youku' && v.provider !== 'tencent')) return
  tmdbLoading.value = true
  try {
    tmdbHits.value = await gvs('tmdbSearch', v.title, v.kind !== 'movie')
    const exact = tmdbHits.value.find((h) => h.name === v.title && (!v.year || h.year === v.year)) ?? tmdbHits.value[0]
    tmdb.value = exact ?? null
  } catch (e) {
    tmdbError.value = errText(e)
  } finally {
    tmdbLoading.value = false
  }
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
    tmdb: tmdb.value ? { ...tmdb.value } : null,
  }
})

let namingSeq = 0
watch(
  request,
  async (r) => {
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
const noun = computed(() => d.value?.pickNoun ?? '集')

async function start() {
  const r = request.value
  if (!r) return
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

const spec = (q: { width: number; height: number; size: number; fps: number }) =>
  [q.width && q.height ? `${q.width}×${q.height}` : '', q.fps ? `${q.fps}帧` : '', q.size ? `每${noun.value === '集' ? '集' : '个'}约 ${human(q.size)}` : '']
    .filter(Boolean)
    .join(' · ')
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
</script>

<template>
  <div class="page">
    <button type="button" class="back" @click="back('detail')"><Icon name="back" :size="16" />{{ d?.title ?? '返回' }}</button>
    <div class="h1-row">
      <h1 class="h1">选择画质</h1>
      <span class="muted">已选 {{ count }} {{ noun }} · 按第一{{ noun === '集' ? '集' : '个' }}探测，整批沿用</span>
    </div>

    <div v-if="store.probing" class="empty"><span class="spin" />正在向平台取画质…</div>
    <div v-else-if="store.probeError" class="error-box">
      取画质失败：{{ store.probeError }}
      <div style="margin-top: 10px"><button type="button" class="btn sm" @click="openQuality">重试</button></div>
    </div>
    <div v-else-if="probe" class="cols">
      <div class="left">
        <div v-if="probe.warning" class="warn-box">{{ probe.warning }}</div>
        <div v-if="probe.vip?.hasTrial" class="warn-box">当前账号只能拿到试看片段，完整版需要会员登录</div>
        <fieldset v-if="audios.length" class="fs abox">
          <legend class="sr-only">音轨</legend>
          <div class="alegend">
            <span class="atitle">音轨</span>
            <span class="muted small">已选 {{ pickedCount }} / {{ audios.length }}</span>
            <span class="aq">
              <button type="button" class="linkish" @click="pickAll">全选</button>
              <button type="button" class="linkish" @click="pickDefault">只要默认</button>
            </span>
          </div>
          <div v-for="g in audioGroups" :key="g.lang" class="agroup">
            <span class="glang">{{ g.lang }}</span>
            <div class="achips">
              <label v-for="a in g.items" :key="a.id" class="achip" :class="{ on: audioIds.includes(a.id) || a.embedded, dis: a.embedded }" :title="a.embedded ? '已内嵌在视频里' : a.codec">
                <input type="checkbox" class="sr-only" :checked="audioIds.includes(a.id) || a.embedded" :disabled="a.embedded" @change="toggleAudio(a)" />
                <Icon v-if="audioIds.includes(a.id) || a.embedded" name="check" :size="13" :stroke="3" />
                {{ a.label }}<span v-if="a.isDefault" class="def">默认</span>
              </label>
            </div>
          </div>
          <div v-if="hasDts" class="muted small">选了 DTS 音轨，会用 MP4Box 封装成 MP4</div>
        </fieldset>
        <fieldset class="fs">
          <legend>视频</legend>
          <label v-for="q in probe.qualities" :key="q.index" class="opt" :class="{ on: q.index === qIndex }">
            <input v-model="qIndex" type="radio" name="quality" :value="q.index" class="sr-only" />
            <span class="radio"><span v-if="q.index === qIndex" /></span>
            <span class="ot">
              <span class="on-t">{{ qname(q) }}</span>
              <span v-if="q.stream" class="mono muted code">{{ q.stream }}</span>
            </span>
            <span class="spec dim">{{ spec(q) }}</span>
          </label>
        </fieldset>

      </div>

      <aside class="card hard out">
        <h2 class="h2s">输出</h2>

        <div v-if="store.state?.settings.tmdbKey && (d?.provider === 'youku' || d?.provider === 'tencent')" class="blk">
          <span class="lab">TMDB 匹配</span>
          <div v-if="tmdbLoading" class="dim small row"><span class="spin" />正在查 TMDB…</div>
          <div v-else-if="tmdbError" class="warn-box">TMDB：{{ tmdbError }}</div>
          <template v-else>
            <div class="match" :class="{ none: !tmdb }">
              <Icon v-if="tmdb" name="check" :size="16" :stroke="2.5" />
              <span>{{ tmdb ? `${tmdb.name}${tmdb.year ? ` (${tmdb.year})` : ''}` : '不使用 TMDB' }}</span>
              <button v-if="tmdbHits.length" type="button" class="linkish" @click="tmdbOpen = !tmdbOpen">{{ tmdbOpen ? '收起' : '更换' }}</button>
            </div>
            <div v-if="tmdbOpen" class="hits">
              <button v-for="h in tmdbHits" :key="h.id" type="button" class="hit" :class="{ on: tmdb?.id === h.id }" @click="(tmdb = h), (tmdbOpen = false)">
                {{ h.name }}<span class="muted mono">{{ h.year || '' }}</span>
              </button>
              <button type="button" class="hit" :class="{ on: !tmdb }" @click="(tmdb = null), (tmdbOpen = false)">不使用 TMDB</button>
            </div>
          </template>
        </div>

        <div v-if="naming" class="blk">
          <span class="lab">文件名预览</span>
          <div class="name mono">{{ sep(naming.folder) }}/<br /><span>{{ naming.file }}</span></div>
        </div>

        <button type="button" class="dir mono" :title="store.state?.settings.outDir" @click="go('settings')">
          <Icon name="folder" :size="16" />{{ store.state?.settings.outDir }}
        </button>

        <div v-if="totalSize" class="sum"><span class="dim">预计占用</span><span class="mono">约 {{ human(totalSize) }} · {{ count }} {{ noun }}</span></div>

        <button type="button" class="btn primary big" :disabled="starting || !quality" @click="start">
          <span v-if="starting" class="spin" /><Icon v-else name="download" />开始下载 {{ count }} {{ noun }}
        </button>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.back { margin-bottom: -8px; }
.cols { display: flex; gap: 28px; align-items: flex-start; }
.left { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
.fs { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
legend { padding: 0 0 10px; font-size: 16px; font-weight: 700; }
.small { font-size: 13px; font-weight: 400; }
.opt {
  padding: 9px 16px; background: var(--card); border: 1.5px solid var(--line); border-radius: 10px; display: flex; align-items: center; gap: 14px; cursor: pointer;
}
.opt:hover { border-color: var(--ink-3); }
.opt.on { border-color: var(--ink); box-shadow: var(--shadow-orange); }
.opt:focus-within { outline: 2px solid var(--orange); outline-offset: 2px; }
.radio { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--ink); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.radio span { width: 10px; height: 10px; border-radius: 50%; background: var(--orange); }
.ot { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.on-t { font-size: 16px; font-weight: 700; }
.code { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spec { margin-left: auto; font-size: 13px; white-space: nowrap; }
.abox { padding: 14px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; gap: 10px; }
.alegend { display: flex; align-items: baseline; gap: 10px; }
.atitle { font-size: 16px; font-weight: 700; }
.aq { margin-left: auto; display: flex; gap: 12px; }
.agroup { display: flex; align-items: center; gap: 14px; }
.glang { width: 56px; flex-shrink: 0; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.achips { display: flex; flex-wrap: wrap; gap: 8px; }
.achip {
  height: 34px; padding: 0 12px; border-radius: 8px; border: 1.5px solid var(--line); background: var(--card);
  display: inline-flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; user-select: none;
}
.achip:hover { border-color: var(--ink-3); }
.achip.on { border-color: var(--ink); background: var(--orange); font-weight: 700; }
.achip.dis { cursor: default; opacity: .8; }
.achip:focus-within { outline: 2px solid var(--orange); outline-offset: 2px; }
.def { font-size: 11px; font-weight: 500; padding: 1px 5px; border-radius: 4px; background: var(--paper-2); color: var(--ink-2); }
.achip.on .def { background: rgba(255, 255, 255, .55); color: var(--ink); }
.out { width: 340px; flex-shrink: 0; padding: 20px; display: flex; flex-direction: column; gap: 16px; position: sticky; top: 0; }
.h2s { font-size: 17px; font-weight: 700; }
.blk { display: flex; flex-direction: column; gap: 6px; }
.lab { font-size: 13px; color: var(--ink-3); }
.row { display: flex; align-items: center; gap: 8px; }
.match { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--ok-bg); color: var(--ok); border-radius: 8px; font-size: 14px; font-weight: 500; }
.match.none { background: var(--paper-2); color: var(--ink-2); }
.match .linkish { margin-left: auto; }
.hits { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.hit { padding: 9px 12px; border: 0; border-bottom: 1px solid var(--line); background: var(--card); text-align: left; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; font-size: 14px; }
.hit:last-child { border-bottom: 0; }
.hit:hover, .hit.on { background: var(--paper-2); }
.name { padding: 10px 12px; background: var(--ink); color: var(--paper); border-radius: 8px; font-size: 12px; line-height: 1.7; word-break: break-all; }
.name span { color: var(--orange); }
.dir { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; word-break: break-all; }
.dir:hover { color: var(--orange-text); }
.sum { display: flex; justify-content: space-between; font-size: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
</style>
