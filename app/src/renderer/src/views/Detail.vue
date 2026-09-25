<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PROVIDER_NAME } from '@shared/api'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import Poster from '../components/Poster.vue'
import { back, openQuality, store } from '../store'

const d = computed(() => store.detail)
const eps = computed(() => d.value?.episodes ?? [])
const picked = computed(() => new Set(store.picked))
const range = ref('')
const anchor = ref(-1)
watch(d, () => {
  range.value = ''
  anchor.value = -1
})

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
const cols = computed(() => (eps.value.length > 200 ? 'repeat(auto-fill, minmax(60px, 1fr))' : 'repeat(auto-fill, minmax(64px, 1fr))'))
const meta = computed(() => {
  const v = d.value
  if (!v) return ''
  return [v.year || '', v.episodeCount && !isMovie.value ? `${v.episodeCount} 集` : '', v.category, v.tags.join(' / ')]
    .filter(Boolean)
    .join(' · ')
})
const label = (n: number) => String(n).padStart(eps.value.length >= 100 ? 3 : 2, '0')
</script>

<template>
  <div class="page">
    <button type="button" class="back" @click="back('search')"><Icon name="back" :size="16" />返回</button>

    <div v-if="store.detailLoading" class="empty"><span class="spin" />正在加载详情…</div>
    <div v-else-if="store.detailError" class="error-box">{{ store.detailError }}</div>
    <template v-else-if="d">
      <div class="hero">
        <Poster class="poster" :url="d.poster" :provider="d.provider" :title="d.title" :title-size="22" />
        <div class="info">
          <div class="src dim"><PlatformLogo :provider="d.provider" :size="18" /><span>{{ PROVIDER_NAME[d.provider] }}</span><span v-if="d.category">· {{ d.category }}</span></div>
          <h1 class="title">{{ d.title }}</h1>
          <span v-if="meta" class="dim meta">{{ meta }}</span>
          <div class="chips">
            <span v-if="d.vip" class="chip warn">VIP</span>
            <span v-if="d.drm" class="chip">DRM · {{ d.drm }}</span>
            <span v-if="d.score" class="chip mono">{{ d.score }}</span>
          </div>
          <p v-if="d.desc" class="desc">{{ d.desc }}</p>
        </div>
      </div>

      <section class="card eps">
        <div class="eps-h">
          <h2 class="h2s">{{ isMovie ? '版本' : `正片 ${eps.length} 集` }}</h2>
          <span v-if="!isMovie" class="muted small">预告已自动隐藏 · 按住 Shift 可连选</span>
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

        <div v-if="!eps.length" class="empty">这部没有返回可下载的正片</div>
        <div v-else-if="isMovie" class="editions">
          <button
            v-for="(e, i) in eps"
            :key="e.vid"
            type="button"
            class="edition"
            :class="{ on: picked.has(e.vid) }"
            :aria-pressed="picked.has(e.vid)"
            @click="toggle(i, $event)"
          >
            <span class="box"><Icon v-if="picked.has(e.vid)" name="check" :size="14" :stroke="3" /></span>
            <span class="et">{{ e.title || '正片' }}</span>
            <span v-if="e.duration" class="muted mono">{{ Math.round(e.duration / 60) }} 分钟</span>
          </button>
        </div>
        <div v-else class="grid" :style="{ gridTemplateColumns: cols }">
          <button
            v-for="(e, i) in eps"
            :key="e.vid"
            type="button"
            class="ep mono"
            :class="{ on: picked.has(e.vid) }"
            :aria-pressed="picked.has(e.vid)"
            :title="e.title"
            @click="toggle(i, $event)"
          >
            {{ label(e.number) }}
          </button>
        </div>

        <div class="foot">
          <span><b class="mono n">{{ store.picked.length }}</b> {{ d.pickNoun }}已选</span>
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
.hero { display: flex; gap: 28px; }
.poster { width: 172px; height: 244px; }
.info { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
.src { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.title { font-family: var(--font-display); font-size: 44px; font-weight: 800; letter-spacing: -.5px; line-height: 1.05; }
.meta { font-size: 15px; }
.desc { font-size: 14px; line-height: 1.7; color: var(--ink-2); max-width: 720px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.eps { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
.eps-h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.h2s { font-size: 17px; font-weight: 700; }
.small { font-size: 13px; }
.tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.range { height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; display: flex; align-items: center; gap: 8px; }
.range:focus-within { border-color: var(--ink); }
.range input { width: 80px; border: 0; outline: 0; font-size: 14px; background: transparent; }
.grid { display: grid; gap: 8px; max-height: 420px; overflow-y: auto; padding: 2px; }
.ep { height: 40px; border-radius: 6px; border: 1.5px solid var(--line); background: var(--card); font-size: 14px; cursor: pointer; }
.ep:hover { border-color: var(--ink); }
.ep.on { background: var(--orange); border-color: var(--ink); font-weight: 700; }
.editions { display: flex; flex-direction: column; gap: 8px; }
.edition { height: 50px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); display: flex; align-items: center; gap: 12px; cursor: pointer; font-size: 15px; text-align: left; }
.edition.on { border-color: var(--ink); }
.box { width: 20px; height: 20px; border-radius: 5px; border: 2px solid var(--ink); display: flex; align-items: center; justify-content: center; }
.edition.on .box { background: var(--orange); }
.et { font-weight: 500; flex-grow: 1; }
.foot {
  position: sticky; bottom: 0; margin: 0 -20px -18px; padding: 14px 20px 18px; background: var(--card);
  border-top: 1px solid var(--line); border-radius: 0 0 10px 10px; display: flex; align-items: center; gap: 16px;
}
.foot .n { font-size: 18px; }
.foot .btn { margin-left: auto; }
</style>
