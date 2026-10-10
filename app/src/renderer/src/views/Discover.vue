<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PROVIDER_NAME, type Card, type Provider, type Section } from '@shared/api'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import Poster from '../components/Poster.vue'
import Skeleton from '../components/Skeleton.vue'
import { errText, go, gvs, openCard, store } from '../store'

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
const moreError = ref('')
const notice = ref('')
const sentinel = ref<HTMLElement | null>(null)
let gen = 0
let io: IntersectionObserver | null = null

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
  moreError.value = ''
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
  if (!provider.value || !section.value || !more.value || loadingMore.value) return
  const g = gen
  loadingMore.value = true
  moreError.value = ''
  try {
    const r = await gvs('browse', provider.value, { ...section.value }, next.value)
    if (g !== gen) return
    const seen = new Set(cards.value.map((c) => c.id || c.title))
    const fresh = r.cards.filter((c) => !seen.has(c.id || c.title))
    cards.value = [...cards.value, ...fresh]
    more.value = r.more && fresh.length > 0 && r.next !== next.value
    next.value = r.next
  } catch (e) {
    moreError.value = errText(e)
  } finally {
    loadingMore.value = false
  }
}

const isRank = computed(() => section.value?.mode === 'rank' || cards.value.some((c) => c.rank))
/** 热搜这类只有关键词、没有海报的榜单：用排行列表，不画一墙空海报 */
const listMode = computed(() => cards.value.length > 0 && cards.value.filter((c) => c.poster).length < cards.value.length * 0.3)
const rankSkeleton = computed(() => section.value?.mode === 'rank')

const visibleSections = computed(() => sections.value.filter((s) => s.available))
const sectionGroup = (s: Section) => s.title.split(' · ')[0] || s.title
const groups = computed(() => [...new Set(visibleSections.value.map(sectionGroup))])
const activeGroup = computed(() => section.value ? sectionGroup(section.value) : '')
const groupSections = computed(() => visibleSections.value.filter(s => sectionGroup(s) === activeGroup.value))
const hasSubsections = computed(() => groupSections.value.length > 1 || groupSections.value.some(s => s.title.includes(' · ')))
function chooseGroup(group: string) {
  const candidates = visibleSections.value.filter(s => sectionGroup(s) === group)
  void choose(candidates.find(s => s.title === group) ?? candidates[0] ?? null)
}
const subsectionTitle = (s: Section) => s.title === sectionGroup(s) ? '推荐' : s.title.split(' · ').slice(1).join(' · ')

/** 进行中的批次：running/queued/paused 都算 */
const active = computed(() => {
  const jobs = store.jobs.filter((j) => j.state === 'running' || j.state === 'queued' || j.state === 'paused')
  if (!jobs.length) return null
  const cur = jobs.find((j) => j.state === 'running' || j.state === 'queued') ?? jobs[0]!
  return { n: jobs.length, title: cur.groupTitle, pct: Math.round(cur.pct * 100) }
})

onMounted(() => {
  io = new IntersectionObserver(
    (es) => {
      if (es.some((e) => e.isIntersecting)) void loadMore()
    },
    { rootMargin: '320px' },
  )
  if (sentinel.value) io.observe(sentinel.value)
})
watch(sentinel, (el, old) => {
  if (old) io?.unobserve(old)
  if (el) io?.observe(el)
})
onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="h1">发现</h1>
      <div class="tabs">
        <button v-for="p in browsable" :key="p" type="button" class="pill" :class="{ on: p === provider }" @click="pick(p)">
          <PlatformLogo :provider="p" :size="16" />{{ PROVIDER_NAME[p] }}
        </button>
      </div>
    </div>

    <button v-if="active" type="button" class="live" @click="go('downloads')">
      <span class="dot live-dot" />
      <span class="lt"><b>{{ active.n }} 个任务进行中</b> · {{ active.title }} {{ active.pct }}%</span>
      <span class="lbar"><span :style="{ width: active.pct + '%' }" /></span>
      <span class="la">去下载<Icon name="arrow" :size="15" /></span>
    </button>

    <div v-if="visibleSections.length > 1" class="sections">
      <button
        v-for="group in groups"
        :key="group"
        type="button"
        class="sec"
        :class="{ on: group === activeGroup }"
        @click="chooseGroup(group)"
      >
        {{ group }}
      </button>
    </div>
    <div v-if="hasSubsections" class="sections subsections" aria-label="二级栏目">
      <button v-for="s in groupSections" :key="s.id" type="button" class="sec" :class="{ on: s.id === section?.id }" @click="choose(s)">
        {{ subsectionTitle(s) }}
      </button>
    </div>

    <div v-if="error" class="error-box browse-error">
      <span>{{ error }}</span>
      <button type="button" class="btn" :disabled="loading" @click="section ? choose(section) : pick(provider)"><Icon name="retry" :size="15" />重试</button>
    </div>
    <template v-else-if="loading">
      <ol v-if="rankSkeleton" class="ranklist">
        <li v-for="i in 8" :key="i" class="card rl rl-sk">
          <Skeleton w="36" h="26" r="6" />
          <span class="rl-b"><Skeleton w="62%" h="15" /><Skeleton w="38%" h="13" /></span>
        </li>
      </ol>
      <section v-else class="grid">
        <div v-for="i in 12" :key="i" class="item">
          <Skeleton w="100%" h="auto" r="8" class="p-sk" />
          <Skeleton w="86%" h="15" />
          <Skeleton w="56%" h="13" />
        </div>
      </section>
    </template>
    <div v-else-if="!cards.length" class="empty">{{ notice || (browsable.length ? '这个栏目暂时没有内容' : '当前 Key 没有可浏览的平台') }}</div>
    <ol v-else-if="listMode" class="ranklist">
      <li v-for="(c, i) in cards" :key="c.id || c.title">
        <button type="button" class="rl" :disabled="c.target === 'unavailable'" :title="c.reason || c.title" @click="openCard(c)">
          <span class="rl-n" :class="{ top: isRank && i < 3 }">{{ isRank ? i + 1 : '' }}</span>
          <span class="rl-b">
            <span class="rl-t">{{ c.title }}</span>
            <span v-if="c.meta || c.desc" class="rl-m">{{ c.meta || c.desc }}</span>
          </span>
          <span class="rl-a">{{ c.video || c.target === 'detail' ? '详情' : c.target === 'search' ? '搜索' : '预约' }}<Icon name="arrow" :size="15" /></span>
        </button>
      </li>
    </ol>
    <section v-else class="grid">
      <button v-for="(c, i) in cards" :key="c.id || c.title" type="button" class="item" :disabled="c.target === 'unavailable'" :title="c.reason || c.title" @click="openCard(c)">
        <div class="pwrap">
          <Poster class="p" :url="c.poster" :provider="c.provider" :title="c.title" :title-size="17" :loading="i < 6 ? 'eager' : 'lazy'" />
          <span class="veil"><span class="tag">{{ c.target === 'search' ? '搜索' : c.target === 'unavailable' ? '暂不可用' : '查看详情' }}<Icon name="arrow" :size="14" /></span></span>
          <span v-if="isRank" class="rank">{{ i + 1 }}</span>
          <span v-if="c.vip" class="vip">VIP</span>
        </div>
        <span class="t">{{ c.title }}</span>
        <span class="m">{{ c.meta || c.desc }}</span>
      </button>
    </section>

    <div v-if="more && !loading" ref="sentinel" class="sent">
      <template v-if="loadingMore">
        <div v-if="listMode" class="card rl rl-sk"><Skeleton w="36" h="26" r="6" /><span class="rl-b"><Skeleton w="62%" h="15" /><Skeleton w="38%" h="13" /></span></div>
        <div v-else class="item"><Skeleton w="100%" h="auto" r="8" class="p-sk" /><Skeleton w="86%" h="15" /><Skeleton w="56%" h="13" /></div>
      </template>
      <button v-else-if="moreError" type="button" class="btn" @click="loadMore"><Icon name="retry" :size="15" />加载失败，重试</button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.browse-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.browse-error .btn { flex-shrink: 0; }
.live {
  display: flex; align-items: center; gap: 12px; width: 100%; height: 40px; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--card); cursor: pointer; text-align: left;
}
.live:hover { border-color: var(--ink); }
.live-dot { background: var(--orange); }
.lt { font-size: 13px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lt b { color: var(--ink); }
.lbar { flex-grow: 1; min-width: 60px; height: 4px; border-radius: 999px; background: var(--paper-2); overflow: hidden; }
.lbar span { display: block; height: 100%; background: var(--orange); }
.la { display: flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 700; color: var(--orange-text); flex-shrink: 0; }
.sections { display: flex; gap: 4px; flex-wrap: wrap; margin-top: -8px; }
.subsections { max-height: 140px; overflow-y: auto; padding: 6px 0; border-top: 1px solid var(--line); }
.sec { height: 32px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; font-size: 14px; color: var(--ink-2); cursor: pointer; }
.sec:hover { background: var(--paper-2); }
.sec.on { background: var(--paper-2); color: var(--ink); font-weight: 700; box-shadow: inset 0 -2px 0 var(--orange); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 22px 20px; }
.item { display: flex; flex-direction: column; gap: 8px; min-width: 0; background: none; border: 0; padding: 0; text-align: left; cursor: pointer; }
.item:disabled { cursor: not-allowed; opacity: .6; }
.pwrap { position: relative; }
.p { width: 100%; aspect-ratio: 150 / 214; }
.p-sk { aspect-ratio: 150 / 214; height: auto; }
.item:hover:not(:disabled) .p { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--ink); }
.p { transition: transform .12s, box-shadow .12s; }
.rank {
  position: absolute; top: 10px; left: 10px; min-width: 30px; height: 30px; padding: 0 6px; border-radius: 6px; background: var(--orange);
  color: var(--ink); font-family: var(--font-display); font-size: 17px; font-weight: 800; display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--ink);
}
.vip { position: absolute; top: 10px; right: 10px; padding: 2px 7px; border-radius: 5px; background: var(--orange-soft); color: var(--orange-text); font-size: 11px; font-weight: 700; }
.veil {
  position: absolute; inset: 0; border-radius: 8px; background: rgba(23, 24, 28, .5); opacity: 0; transition: opacity .14s;
  display: flex; align-items: flex-end; padding: 12px;
}
.item:hover:not(:disabled) .veil, .item:focus-visible .veil { opacity: 1; }
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 6px; background: var(--orange); color: var(--ink); font-size: 12px; font-weight: 700; }
.t { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m { font-size: 13px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -4px; }
.sent { display: flex; justify-content: center; padding-top: 4px; }
.sent > .item { width: 150px; }
.ranklist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 20px; }
.rl {
  width: 100%; height: 64px; padding: 0 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  display: flex; align-items: center; gap: 16px; cursor: pointer; text-align: left;
}
.rl:hover:not(:disabled) { border-color: var(--ink); box-shadow: 3px 3px 0 var(--ink); }
.rl:disabled { opacity: .6; cursor: not-allowed; }
.rl-sk { cursor: default; gap: 16px; }
.rl-n { width: 36px; font-family: var(--font-display); font-size: 24px; font-weight: 800; color: var(--ink-3); text-align: center; flex-shrink: 0; }
.rl-n.top { color: var(--orange); }
.rl-b { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.rl-t { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-m { font-size: 13px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-a { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--ink-2); flex-shrink: 0; }
</style>
