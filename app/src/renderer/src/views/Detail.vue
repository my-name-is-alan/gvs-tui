<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PROVIDER_NAME } from '@shared/api'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import Poster from '../components/Poster.vue'
import Skeleton from '../components/Skeleton.vue'
import { back, openQuality, store } from '../store'

const d = computed(() => store.detail)
const collection = ref('')
const collections = computed(() => {
  const names = [...new Set((d.value?.episodes ?? []).map(e => e.collection).filter((g): g is string => !!g))]
  return names.includes('正片') ? ['正片', ...names.filter(g => g !== '正片')] : names
})
const eps = computed(() => (d.value?.episodes ?? []).filter(e => !collection.value || e.collection === collection.value))
const duplicateNumbers = computed(() => new Set(eps.value.map(e => e.number)).size < eps.value.length)
const picked = computed(() => new Set(store.picked))
const range = ref('')
const anchor = ref(-1)
watch(d, () => {
  range.value = ''
  anchor.value = -1
  collection.value = d.value?.episodes.find(e => e.vid === d.value?.focusVid)?.collection ?? collections.value[0] ?? ''
}, { immediate: true })

function switchCollection(name: string) {
  collection.value = name
  store.picked = []
  anchor.value = -1
  range.value = ''
}

function setPicked(vids: string[]) {
  store.picked = eps.value.filter((e) => vids.includes(e.vid)).map((e) => e.vid)
}

function toggle(i: number, e: MouseEvent) {
  const ep = eps.value[i]
  if (!ep) return
  if (e.shiftKey && anchor.value >= 0) {
    const [a, b] = [Math.min(anchor.value, i), Math.max(anchor.value, i)]
    const on = !picked.value.has(ep.vid)
    const span = eps.value.slice(a, b + 1).map((x) => x.vid)
    const set = new Set(store.picked)
    for (const v of span) on ? set.add(v) : set.delete(v)
    setPicked([...set])
  } else {
    const set = new Set(store.picked)
    set.has(ep.vid) ? set.delete(ep.vid) : set.add(ep.vid)
    setPicked([...set])
  }
  anchor.value = i
}

function applyRange() {
  const nums = new Set<number>()
  for (const part of range.value.split(/[,，\s]+/)) {
    const m = /^(\d+)(?:\s*[-~–]\s*(\d+))?$/.exec(part.trim())
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 5000; n++) nums.add(n)
  }
  setPicked(eps.value.filter((e) => nums.has(e.number)).map((e) => e.vid))
}

const all = () => setPicked(eps.value.map((e) => e.vid))
const invert = () => setPicked(eps.value.filter((e) => !picked.value.has(e.vid)).map((e) => e.vid))
const clear = () => setPicked([])

const isMovie = computed(() => d.value?.kind === 'movie')
const meta = computed(() => {
  const v = d.value
  if (!v) return ''
  return [v.year || '', v.episodeCount && !isMovie.value ? `${v.episodeCount} ${collections.value.length ? '条' : '集'}` : '', v.category, v.tags.join(' / ')]
    .filter(Boolean)
    .join(' · ')
})
const label = (n: number) => String(n).padStart(eps.value.length >= 100 ? 3 : 2, '0')
function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '时长未知'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds % 3600 / 60)
  const s = String(Math.floor(seconds % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** 还没拿到详情时：先用卡片带上来的标题/海报撑住骨架 */
const hint = computed(() => store.detailHint ?? {})
const hintPoster = computed(() => hint.value.poster ?? '')
const descOpen = ref(false)
/** 4 行以上的简介才给展开按钮（按字符数估，不引额外测量） */
const descLong = computed(() => (d.value?.desc?.length ?? 0) > 150)
</script>

<template>
  <div class="page">
    <button type="button" class="back" @click="back('search')"><Icon name="back" :size="16" />返回</button>

    <template v-if="store.detailLoading">
      <div class="hero">
        <div class="wrap">
          <Poster v-if="hintPoster" class="poster" :url="hintPoster" :title="hint.title ?? ''" :title-size="22" />
          <Skeleton v-else class="poster-sk" w="172" h="244" r="8" />
        </div>
        <div class="info">
          <Skeleton w="140" h="14" />
          <h1 v-if="hint.title" class="title">{{ hint.title }}</h1>
          <Skeleton v-else w="58%" h="42" r="8" />
          <Skeleton w="42%" h="15" />
          <div class="chips"><Skeleton w="52" h="24" r="6" /><Skeleton w="88" h="24" r="6" /></div>
          <Skeleton w="96%" h="14" /><Skeleton w="92%" h="14" /><Skeleton w="70%" h="14" />
        </div>
      </div>
      <section class="card eps">
        <div class="eps-h">
          <Skeleton w="120" h="19" r="6" />
          <div class="sk-tools"><Skeleton w="120" h="36" r="8" /><Skeleton w="58" h="36" r="8" /><Skeleton w="58" h="36" r="8" /></div>
        </div>
        <div class="sk-grid">
          <Skeleton v-for="i in 56" :key="i" h="40" r="6" />
        </div>
        <div class="sk-foot"><Skeleton w="110" h="16" /><Skeleton w="176" h="46" r="8" /></div>
      </section>
    </template>
    <div v-else-if="store.detailError" class="error-box">{{ store.detailError }}</div>
    <template v-else-if="d">
      <div class="hero">
        <span v-if="d.poster" class="hero-bg" :style="{ backgroundImage: `url(${d.poster})` }" aria-hidden="true" />
        <div class="wrap"><Poster class="poster" :url="d.poster" :provider="d.provider" :title="d.title" :title-size="22" /></div>
        <div class="info">
          <div class="src dim"><PlatformLogo :provider="d.provider" :size="18" /><span>{{ PROVIDER_NAME[d.provider] }}</span><span v-if="d.category">· {{ d.category }}</span></div>
          <h1 class="title">{{ d.title }}</h1>
          <span v-if="meta" class="dim meta">{{ meta }}</span>
          <div class="chips">
            <span v-if="d.vip" class="chip warn">VIP</span>
            <span v-if="d.drm" class="chip">DRM · {{ d.drm }}</span>
            <span v-if="d.score" class="chip mono">{{ d.score }}</span>
          </div>
          <p v-if="d.desc" class="desc" :class="{ open: descOpen }">{{ d.desc }}</p>
          <button v-if="descLong" type="button" class="linkish more" :aria-expanded="descOpen" @click="descOpen = !descOpen">{{ descOpen ? '收起' : '展开' }}</button>
        </div>
      </div>

      <section class="card eps">
        <div class="eps-h">
          <h2 class="h2s">{{ isMovie ? '版本' : `${collection || '选集'} ${eps.length} 条` }}</h2>
          <span v-if="!isMovie" class="muted small">{{ collection ? '仅选择当前栏目 · 按住 Shift 可连选' : '按标题和时长区分正片与片段 · 按住 Shift 可连选' }}</span>
          <div v-if="!isMovie && eps.length > 1" class="tools">
            <form class="range" @submit.prevent="applyRange">
              <label for="range" class="small dim">范围</label>
              <input id="range" v-model="range" class="mono" placeholder="1-12" @blur="range && applyRange()" />
            </form>
            <button type="button" class="btn sm" @click="all">全选</button>
            <button type="button" class="btn sm" @click="invert">反选</button>
            <button type="button" class="btn sm" @click="clear">清空</button>
          </div>
        </div>

        <div v-if="collections.length > 1" class="collection-tabs" role="tablist" aria-label="节目栏目">
          <button v-for="name in collections" :key="name" type="button" role="tab"
            class="btn sm" :class="{ primary: collection === name }" :aria-selected="collection === name"
            @click="switchCollection(name)">{{ name }}</button>
        </div>
        <div v-if="!eps.length" class="empty">当前栏目没有返回可下载的视频</div>
        <p v-if="duplicateNumbers && !isMovie" class="muted small">同集号有多个条目，请按标题和时长确认。</p>
        <div v-if="eps.length && isMovie" class="editions">
          <button
            v-for="(e, i) in eps"
            :key="e.vid"
            type="button"
            class="edition"
            :class="{ on: picked.has(e.vid) }"
            :aria-pressed="picked.has(e.vid)"
            :title="`${e.title || '正片'} · ${duration(e.duration)}`"
            @click="toggle(i, $event)"
          >
            <span class="box"><Icon v-if="picked.has(e.vid)" name="check" :size="14" :stroke="3" /></span>
            <span class="et">{{ e.title || '正片' }}</span>
            <span class="muted mono">{{ duration(e.duration) }}</span>
          </button>
        </div>
        <div v-if="eps.length && !isMovie" class="grid">
          <button
            v-for="(e, i) in eps"
            :key="e.vid"
            type="button"
            class="ep"
            :class="{ on: picked.has(e.vid) }"
            :aria-pressed="picked.has(e.vid)"
            :aria-label="`第 ${e.number} 集，${e.title || '标题未提供'}，${duration(e.duration)}${e.collection ? `，栏目：${e.collection}` : ''}`"
            :title="`${e.title || '标题未提供'} · ${duration(e.duration)}`"
            @click="toggle(i, $event)"
          >
            <span class="episode-number mono">{{ label(e.number) }}</span>
            <span class="episode-info"><span class="episode-title">{{ e.title || '标题未提供' }}</span><span class="episode-meta mono">{{ duration(e.duration) }}</span></span>
            <Icon v-if="picked.has(e.vid)" class="episode-check" name="check" :size="14" :stroke="3" />
          </button>
        </div>

        <div class="foot">
          <span><b class="mono n">{{ store.picked.length }}</b> {{ collection ? '条' : d.pickNoun }}已选</span>
          <button type="button" class="btn primary" :disabled="!store.picked.length" @click="openQuality">
            下一步：选画质<Icon name="arrow" />
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.back { margin-bottom: -8px; }
.hero { display: flex; gap: 28px; position: relative; }
.hero-bg {
  position: absolute; inset: -20px -32px auto; height: 300px; z-index: 0; pointer-events: none;
  background-size: cover; background-position: center 20%; filter: blur(48px) saturate(1.3); opacity: .35;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, .5) 55%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, .5) 55%, transparent 100%);
}
.hero > *:not(.hero-bg) { position: relative; z-index: 1; }
.wrap { flex-shrink: 0; }
.poster { width: 172px; height: 244px; box-shadow: 6px 6px 0 var(--ink); }
.poster-sk { box-shadow: 6px 6px 0 var(--ink); }
.info { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding-top: 4px; }
.src { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.title { font-family: var(--font-display); font-size: 44px; font-weight: 800; letter-spacing: -.5px; line-height: 1.05; }
.meta { font-size: 15px; }
.desc { font-size: 14px; line-height: 1.7; color: var(--ink-2); max-width: 720px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.desc.open { -webkit-line-clamp: unset; }
.more { margin-top: -6px; }
.eps { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; position: relative; z-index: 1; background: var(--card); }
.eps-h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.h2s { font-size: 17px; font-weight: 700; }
.small { font-size: 13px; }
.tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.range { height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; display: flex; align-items: center; gap: 8px; }
.range:focus-within { border-color: var(--ink); }
.range input { width: 80px; border: 0; outline: 0; font-size: 14px; background: transparent; }
.collection-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.episode-number { font-size: 16px; font-weight: 700; flex-shrink: 0; }
.episode-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.episode-title { font-size: 13px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.episode-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--ink-3); font-weight: 400; }
.ep.on .episode-meta { color: var(--ink-2); }
.episode-check { flex-shrink: 0; }
/* 和整页一起滚：内层再套一个滚动区会让 sticky 底栏压住最后几行 */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); gap: 8px; padding: 2px; }
.ep { min-height: 64px; padding: 8px 12px; display: flex; gap: 12px; align-items: center; text-align: left; border-radius: 6px; border: 1.5px solid var(--line); background: var(--card); cursor: pointer; min-width: 0; }
.ep:hover { border-color: var(--ink); }
.ep.on { background: var(--orange); border-color: var(--ink); font-weight: 700; }
.editions { display: flex; flex-direction: column; gap: 8px; }
.edition { height: 50px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); display: flex; align-items: center; gap: 12px; cursor: pointer; font-size: 15px; text-align: left; }
.edition.on { border-color: var(--ink); }
.box { width: 20px; height: 20px; border-radius: 5px; border: 2px solid var(--ink); display: flex; align-items: center; justify-content: center; }
.edition.on .box { background: var(--orange); }
.et { font-weight: 500; flex-grow: 1; }
/* sticky 以滚动容器的内容盒为界：抵掉 .page 的 40px 底内边距，才能贴住窗口底边 */
.foot {
  position: sticky; bottom: -40px; margin: 0 -20px -18px; padding: 14px 20px 18px; background: var(--card);
  border-top: 1px solid var(--line); border-radius: 0 0 10px 10px; display: flex; align-items: center; gap: 16px;
}
.foot .n { font-size: 18px; }
.foot .btn { margin-left: auto; }
.sk-tools { margin-left: auto; display: flex; gap: 8px; }
.sk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 8px; }
.sk-foot { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; }
</style>
