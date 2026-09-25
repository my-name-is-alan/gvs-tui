<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PROVIDER_NAME, type Card, type Provider, type Section } from '@shared/api'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import Poster from '../components/Poster.vue'
import { errText, go, gvs, openDetail, runSearch, store } from '../store'

defineOptions({ name: 'DiscoverView' })

const browsable = computed<Provider[]>(() => (store.state?.providers ?? []).filter((p) => p !== 'douyin'))
const provider = ref<Provider | null>(null)
const sections = ref<Section[]>([])
const section = ref<Section | null>(null)
const cards = ref<Card[]>([])
const next = ref('')
const more = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const notice = ref('')
let gen = 0

watch(
  browsable,
  (list) => {
    if (!provider.value || !list.includes(provider.value)) void pick(list[0] ?? null)
  },
  { immediate: true },
)

async function pick(p: Provider | null) {
  provider.value = p
  sections.value = []
  section.value = null
  cards.value = []
  error.value = ''
  if (!p) return
  const g = ++gen
  loading.value = true
  try {
    const list = await gvs('catalog', p)
    if (g !== gen) return
    sections.value = list
    const first = list.find((s) => s.available) ?? list[0]
    await choose(first ?? null)
  } catch (e) {
    if (g === gen) error.value = errText(e)
  } finally {
    if (g === gen) loading.value = false
  }
}

async function choose(s: Section | null) {
  section.value = s
  cards.value = []
  more.value = false
  next.value = ''
  notice.value = ''
  error.value = ''
  if (!s || !provider.value) return
  const g = ++gen
  loading.value = true
  try {
    const r = await gvs('browse', provider.value, { ...s })
    if (g !== gen) return
    cards.value = r.cards
    for (const c of r.channels) if (!sections.value.some((x) => x.id === c.id)) sections.value.push(c)
    more.value = r.more
    next.value = r.next
    notice.value = r.notice
  } catch (e) {
    if (g === gen) error.value = errText(e)
  } finally {
    if (g === gen) loading.value = false
  }
}

async function loadMore() {
  if (!provider.value || !section.value || !more.value) return
  const g = gen
  loadingMore.value = true
  try {
    const r = await gvs('browse', provider.value, { ...section.value }, next.value)
    if (g !== gen) return
    const seen = new Set(cards.value.map((c) => c.id || c.title))
    const fresh = r.cards.filter((c) => !seen.has(c.id || c.title))
    cards.value = [...cards.value, ...fresh]
    more.value = r.more && fresh.length > 0 && r.next !== next.value
    next.value = r.next
  } catch (e) {
    error.value = errText(e)
  } finally {
    loadingMore.value = false
  }
}

function open(c: Card) {
  if (c.target === 'unavailable') return
  if (c.target === 'detail' && c.id) void openDetail(c.provider, c.id)
  else void runSearch(c.title)
}

/** 热搜这类只有关键词、没有海报的榜单：用排行列表，不画一墙空海报 */
const listMode = computed(() => cards.value.length > 0 && cards.value.filter((c) => c.poster).length < cards.value.length * 0.3)
const isRank = computed(() => section.value?.mode === 'rank' || cards.value.some((c) => c.rank))

const visibleSections = computed(() => sections.value.filter((s) => s.available))

/** 最近的下载批次（按剧分组，最多 3 组） */
const recent = computed(() => {
  const groups = new Map<string, { title: string; provider: Provider; poster: string; total: number; done: number; failed: number }>()
  for (const j of [...store.jobs].reverse()) {
    const g = groups.get(j.groupId) ?? { title: j.groupTitle, provider: j.provider, poster: j.poster, total: 0, done: 0, failed: 0 }
    g.total++
    if (j.state === 'done') g.done++
    if (j.state === 'failed') g.failed++
    groups.set(j.groupId, g)
  }
  return [...groups.values()].slice(0, 3)
})
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="h1">发现</h1>
      <div class="tabs">
        <button
          v-for="p in browsable"
          :key="p"
          type="button"
          class="pill"
          :class="{ on: p === provider }"
          @click="pick(p)"
        >
          <PlatformLogo :provider="p" :size="16" />{{ PROVIDER_NAME[p] }}
        </button>
      </div>
    </div>

    <div v-if="visibleSections.length > 1" class="sections">
      <button
        v-for="s in visibleSections"
        :key="s.id"
        type="button"
        class="sec"
        :class="{ on: s.id === section?.id }"
        @click="choose(s)"
      >
        {{ s.title }}
      </button>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-else-if="loading" class="empty"><span class="spin" />正在加载…</div>
    <div v-else-if="!cards.length" class="empty">{{ notice || (browsable.length ? '这个栏目暂时没有内容' : '当前 Key 没有可浏览的平台') }}</div>
    <ol v-else-if="listMode" class="ranklist">
      <li v-for="(c, i) in cards" :key="c.id || c.title">
        <button type="button" class="rl" :disabled="c.target === 'unavailable'" :title="c.reason || c.title" @click="open(c)">
          <span class="rl-n" :class="{ top: isRank && i < 3 }">{{ isRank ? i + 1 : '' }}</span>
          <span class="rl-b">
            <span class="rl-t">{{ c.title }}</span>
            <span v-if="c.meta || c.desc" class="rl-m">{{ c.meta || c.desc }}</span>
          </span>
          <span class="rl-a">{{ c.target === 'search' ? '搜索' : '详情' }}<Icon name="arrow" :size="15" /></span>
        </button>
      </li>
    </ol>
    <section v-else class="grid">
      <button v-for="(c, i) in cards" :key="c.id || c.title" type="button" class="item" :disabled="c.target === 'unavailable'" :title="c.reason || c.title" @click="open(c)">
        <div class="pwrap">
          <Poster class="p" :url="c.poster" :provider="c.provider" :title="c.title" :title-size="17" />
          <span v-if="isRank" class="rank">{{ i + 1 }}</span>
          <span v-if="c.vip" class="vip">VIP</span>
        </div>
        <span class="t">{{ c.title }}</span>
        <span class="m">{{ c.meta || c.desc }}</span>
      </button>
    </section>
    <div v-if="more && !loading" class="more">
      <button type="button" class="btn" :disabled="loadingMore" @click="loadMore">
        <span v-if="loadingMore" class="spin" />{{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
    </div>

    <section v-if="recent.length" class="recent-wrap">
      <div class="rh"><h2 class="h2">最近下载</h2><button type="button" class="linkish" @click="go('downloads')">全部任务</button></div>
      <div class="recent">
        <button v-for="r in recent" :key="r.title" type="button" class="card rc" @click="go('downloads')">
          <Poster :url="r.poster" :provider="r.provider" style="width: 52px; height: 72px; padding: 0" />
          <div class="rc-b">
            <div class="rc-t"><PlatformLogo :provider="r.provider" :size="16" /><span>{{ r.title }}</span></div>
            <span class="dim rc-s">{{ r.done === r.total ? '已完成' : r.failed ? `${r.failed} 集失败` : '下载中' }} · {{ r.done }} / {{ r.total }}</span>
            <div class="progress" :class="{ done: r.done === r.total }"><div :style="{ width: (r.done / r.total) * 100 + '%' }" /></div>
          </div>
          <Icon name="arrow" :size="16" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.sections { display: flex; gap: 4px; flex-wrap: wrap; margin-top: -8px; }
.sec { height: 32px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; font-size: 14px; color: var(--ink-2); cursor: pointer; }
.sec:hover { background: var(--paper-2); }
.sec.on { background: var(--paper-2); color: var(--ink); font-weight: 700; box-shadow: inset 0 -2px 0 var(--orange); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 22px 20px; }
.item { display: flex; flex-direction: column; gap: 8px; min-width: 0; background: none; border: 0; padding: 0; text-align: left; cursor: pointer; }
.item:disabled { cursor: not-allowed; opacity: .6; }
.pwrap { position: relative; }
.p { width: 100%; aspect-ratio: 150 / 214; transition: transform .12s, box-shadow .12s; }
.item:hover:not(:disabled) .p { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--ink); }
.rank {
  position: absolute; top: 10px; left: 10px; min-width: 30px; height: 30px; padding: 0 6px; border-radius: 6px; background: var(--orange);
  color: var(--ink); font-family: var(--font-display); font-size: 17px; font-weight: 800; display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--ink);
}
.vip { position: absolute; top: 10px; right: 10px; padding: 2px 7px; border-radius: 5px; background: var(--orange-soft); color: var(--orange-text); font-size: 11px; font-weight: 700; }
.t { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m { font-size: 13px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -4px; }
.more { display: flex; justify-content: center; }
.ranklist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 20px; }
.rl {
  width: 100%; height: 64px; padding: 0 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  display: flex; align-items: center; gap: 16px; cursor: pointer; text-align: left;
}
.rl:hover:not(:disabled) { border-color: var(--ink); box-shadow: 3px 3px 0 var(--ink); }
.rl:disabled { opacity: .6; cursor: not-allowed; }
.rl-n { width: 36px; font-family: var(--font-display); font-size: 24px; font-weight: 800; color: var(--ink-3); text-align: center; flex-shrink: 0; }
.rl-n.top { color: var(--orange); }
.rl-b { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.rl-t { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-m { font-size: 13px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-a { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--ink-2); flex-shrink: 0; }
.recent-wrap { display: flex; flex-direction: column; gap: 14px; }
.rh { display: flex; align-items: center; justify-content: space-between; }
.recent { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.rc { padding: 14px; display: flex; gap: 14px; align-items: center; cursor: pointer; text-align: left; }
.rc:hover { border-color: var(--ink); }
.rc-b { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.rc-t { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; }
.rc-t span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-s { font-size: 13px; }
</style>
