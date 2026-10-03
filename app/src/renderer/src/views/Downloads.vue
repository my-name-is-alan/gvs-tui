<script setup lang="ts">
import { actualVersionDetail, actualVersionSummary } from '../../../../../src/lib/actual-version'
import TencentDiagnostics from '../components/TencentDiagnostics.vue'
import { computed, reactive, ref, watch } from 'vue'
import type { JobView } from '@shared/api'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import Poster from '../components/Poster.vue'
import { ago, errText, gvs, store, toast } from '../store'

const diagnosticsJob = ref<number | undefined>()
const showDiagnostics = ref(false)
type Filter = 'all' | 'active' | 'paused' | 'failed' | 'done'
const filter = computed({ get: () => store.dlFilter as Filter, set: (v: Filter) => (store.dlFilter = v) })

const count = (pred: (j: JobView) => boolean) => store.jobs.filter(pred).length
const isActive = (j: JobView) => j.state === 'running' || j.state === 'queued'
const counts = computed(() => ({
  all: store.jobs.length,
  active: count(isActive),
  paused: count((j) => j.state === 'paused'),
  failed: count((j) => j.state === 'failed'),
  done: count((j) => j.state === 'done'),
}))
const TABS: Array<{ key: Filter; label: string; empty: string }> = [
  { key: 'all', label: '全部', empty: '还没有下载任务。搜一部剧，选好集数和画质就能开始。' },
  { key: 'active', label: '进行中', empty: '没有正在下载或排队的任务' },
  { key: 'paused', label: '已暂停', empty: '没有暂停的任务' },
  { key: 'failed', label: '失败', empty: '没有失败的任务' },
  { key: 'done', label: '已完成', empty: '还没有已完成的任务' },
]

const match = (j: JobView) =>
  filter.value === 'all' ? true : filter.value === 'active' ? isActive(j) : j.state === filter.value

const groups = computed(() => {
  const map = new Map<string, { id: string; title: string; provider: JobView['provider']; poster: string; quality: string; jobs: JobView[] }>()
  for (const j of store.jobs) {
    let g = map.get(j.groupId)
    if (!g) {
      g = { id: j.groupId, title: j.groupTitle, provider: j.provider, poster: j.poster, quality: j.quality, jobs: [] }
      map.set(j.groupId, g)
    }
    g.jobs.push(j)
  }
  return [...map.values()].reverse()
})
const jobsOf = (g: { jobs: JobView[] }) => g.jobs.filter(match)
const shown = computed(() => groups.value.filter((g) => g.jobs.some(match)))
const hasJobs = computed(() => store.jobs.length > 0)
/** 折叠态按分组 id 记；整组完成的默认折叠，其余默认展开 */
const folds = reactive<Record<string, boolean>>({})

const barClass = (j: JobView) =>
  j.state === 'done' ? 'done' : j.state === 'failed' ? 'fail' : j.state === 'paused' ? 'pause' : /封装|合并|mux|remux/i.test(j.status) ? 'mux' : ''
const pct = (j: JobView) => Math.round((j.state === 'done' ? 1 : j.pct) * 100)
const doneCount = (jobs: JobView[]) => jobs.filter((j) => j.state === 'done').length

const groupPct = (jobs: JobView[]) => (jobs.length ? Math.round((jobs.reduce((s, j) => s + (j.state === 'done' ? 1 : j.pct), 0) / jobs.length) * 100) : 0)
const groupBar = (jobs: JobView[]) =>
  jobs.every((j) => j.state === 'done') ? 'done' : jobs.some(isActive) ? '' : jobs.some((j) => j.state === 'failed') ? 'fail' : 'pause'
const groupStatus = (j: JobView) =>
  j.state === 'queued' ? '排队中' : j.state === 'paused' ? '已暂停' : j.state === 'failed' ? '失败' : j.state === 'done' ? '完成' : j.status
const base = (p: string) => p.split(/[\\/]/).pop() || p
const sub = (j: JobView) =>
  j.state === 'failed' ? j.err
  : j.state === 'done' ? base(j.output)
  : j.state === 'paused' ? '已暂停 · 继续后从断点接着下'
  : j.log || j.status
const subTitle = (j: JobView) => (j.state === 'done' ? j.output : sub(j))

const isFolded = (g: { id: string; jobs: JobView[] }) =>
  folds[g.id] ?? (filter.value === 'all' && g.jobs.every((j) => j.state === 'done'))
const toggleFold = (g: { id: string; jobs: JobView[] }) => (folds[g.id] = !isFolded(g))

/** 按下的按钮先禁用，等主进程推新状态回来 */
const busy = reactive(new Set<number>())
const anyBusy = (ids: number[]) => ids.some((id) => busy.has(id))

async function call(fn: () => Promise<unknown>, ids: number[] = []) {
  ids.forEach((id) => busy.add(id))
  try {
    await fn()
  } catch (e) {
    toast(errText(e), 'err')
  } finally {
    ids.forEach((id) => busy.delete(id))
  }
}
const idsOf = (jobs: JobView[]) => jobs.map((j) => j.id)
const activeIds = (g: { jobs: JobView[] }) => idsOf(g.jobs.filter(isActive))
const pausedIds = (g: { jobs: JobView[] }) => idsOf(g.jobs.filter((j) => j.state === 'paused'))
const runEach = async (fn: (id: number) => Promise<unknown>, ids: number[]) => {
  for (const id of ids) await fn(id)
}

const pendingConfirm = ref<{ kind: 'job' | 'group'; job: JobView | null; group: { title: string; ids: number[] } | null } | null>(null)

function removeJob(j: JobView, deleteFiles: boolean) {
  void call(() => gvs('removeJob', j.id, deleteFiles), [j.id])
}
function removeGroup(ids: number[], deleteFiles: boolean) {
  void call(() => runEach((id) => gvs('removeJob', id, deleteFiles), ids), ids)
}
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="h1">下载</h1>
      <div class="stats">
        <div class="stat"><b class="run">{{ counts.active }}</b><span>进行中</span></div>
        <div class="stat"><b>{{ counts.paused }}</b><span>已暂停</span></div>
        <div class="stat"><b class="bad">{{ counts.failed }}</b><span>失败</span></div>
        <div class="stat"><b class="good">{{ counts.done }}</b><span>已完成</span></div>
      </div>
      <div class="acts">
        <button type="button" class="btn" :disabled="!counts.active" @click="call(() => gvs('pauseAll'))"><Icon name="pause" :size="15" />全部暂停</button>
        <button type="button" class="btn" :disabled="!counts.paused" @click="call(() => gvs('resumeAll'))"><Icon name="play" :size="15" />全部继续</button>
        <button type="button" class="btn" :disabled="!counts.done" @click="call(() => gvs('clearFinished'))"><Icon name="trash" :size="16" />清除已完成</button>
        <button type="button" class="btn" @click="call(() => gvs('openPath', ''))"><Icon name="folder" :size="16" />打开下载目录</button>
      </div>
    </div>

    <div v-if="hasJobs" class="filters">
      <button v-for="t in TABS" :key="t.key" type="button" class="pill" :class="{ on: filter === t.key }" :disabled="!counts[t.key] && t.key !== 'all'" @click="filter = t.key">
        {{ t.label }}<span class="count">{{ counts[t.key] }}</span>
      </button>
    </div>

    <div v-if="!shown.length" class="empty card">
      <Icon name="download" :size="28" />
      <span>{{ TABS.find((t) => t.key === filter)!.empty }}</span>
    </div>

    <section v-for="g in shown" :key="g.id" class="card grp">
      <div class="gh">
        <Poster :url="g.poster" :provider="g.provider" style="width: 34px; height: 48px; padding: 0" />
        <div class="gt">
          <div class="gtt"><PlatformLogo :provider="g.provider" :size="16" /><span class="gname">{{ g.title }}</span></div>
          <span class="muted small">{{ g.jobs.length }} 个任务 · {{ g.quality }}</span>
        </div>
        <div class="gbar">
          <div class="progress" :class="groupBar(g.jobs)"><div :style="{ width: groupPct(g.jobs) + '%' }" /></div>
          <span class="mono small dim">{{ doneCount(g.jobs) }} / {{ g.jobs.length }} 完成</span>
        </div>
        <div class="ga">
          <button
            v-if="activeIds(g).length"
            type="button" class="btn sm" :disabled="anyBusy(activeIds(g))"
            @click="call(() => runEach((id) => gvs('pauseJob', id), activeIds(g)), activeIds(g))"
          >暂停组</button>
          <button
            v-else-if="pausedIds(g).length"
            type="button" class="btn sm outline" :disabled="anyBusy(pausedIds(g))"
            @click="call(() => runEach((id) => gvs('resumeJob', id), pausedIds(g)), pausedIds(g))"
          ><Icon name="play" :size="14" />继续组</button>
          <button type="button" class="btn sm icon" aria-label="删除整组" title="删除整组" @click="pendingConfirm = { kind: 'group', job: null, group: { title: g.title, ids: idsOf(g.jobs) } }"><Icon name="trash" :size="15" /></button>
          <button type="button" class="btn sm icon fold" :aria-expanded="!isFolded(g)" :aria-label="isFolded(g) ? '展开' : '折叠'" @click="toggleFold(g)"><Icon name="chevron" :size="16" /></button>
        </div>
      </div>

      <div v-if="!isFolded(g)" class="jobs">
        <div v-for="j in jobsOf(g)" :key="j.id" class="job">
          <span class="mono lbl">{{ j.label }}</span>
          <div class="st">
            <div class="status-line">
              <span class="stt" :class="j.state">{{ groupStatus(j) }}</span>
              <span v-if="j.state === 'done'" class="muted completed-at">· {{ ago(j.finishedAt) || '刚刚' }}</span>
            </div>
            <span v-if="sub(j)" class="muted sub" :title="subTitle(j)">{{ sub(j) }}</span>
            <span v-if="j.actualVersion && actualVersionSummary(j.actualVersion)" class="muted sub" :title="actualVersionDetail(j.actualVersion)">{{ actualVersionSummary(j.actualVersion) }}</span>
          </div>
          <div class="bar">
            <div class="progress" :class="barClass(j)"><div :style="{ width: pct(j) + '%' }" /></div>
            <span class="mono small dim pc">{{ pct(j) }}%</span>
          </div>
          <div class="ja">
            <button v-if="j.provider === 'tencent'" class="btn sm" @click="diagnosticsJob = j.id; showDiagnostics = true">腾讯诊断</button>
            <template v-if="j.state === 'failed'">
              <button type="button" class="btn sm" :disabled="busy.has(j.id)" @click="call(() => gvs('retryJob', j.id), [j.id])">
                <span v-if="busy.has(j.id)" class="spin" /><Icon v-else name="retry" :size="15" />重试
              </button>
            </template>
            <template v-else-if="j.state === 'paused'">
              <button type="button" class="btn sm outline" :disabled="busy.has(j.id)" @click="call(() => gvs('resumeJob', j.id), [j.id])">
                <span v-if="busy.has(j.id)" class="spin" /><Icon v-else name="play" :size="14" />继续
              </button>
            </template>
            <template v-else-if="j.state === 'done'">
              <button v-if="j.output" type="button" class="btn sm icon" aria-label="打开所在文件夹" title="打开所在文件夹" @click="call(() => gvs('showItem', j.output))"><Icon name="folder" :size="16" /></button>
            </template>
            <template v-else>
              <button type="button" class="btn sm icon" aria-label="暂停" title="暂停" :disabled="busy.has(j.id)" @click="call(() => gvs('pauseJob', j.id), [j.id])">
                <span v-if="busy.has(j.id)" class="spin" /><Icon v-else name="pause" :size="15" />
              </button>
            </template>
            <button type="button" class="btn sm icon del" :aria-label="`删除 ${j.label}`" title="删除" :disabled="busy.has(j.id)" @click="pendingConfirm = { kind: 'job', job: j, group: null }">
              <span v-if="busy.has(j.id)" class="spin" /><Icon v-else name="x" :size="15" />
            </button>
          </div>
        </div>
      </div>
    </section>

    <TencentDiagnostics v-if="showDiagnostics" :job-id="diagnosticsJob" @close="showDiagnostics = false" />
    <ConfirmDialog
      v-if="pendingConfirm?.job"
      title="删除这个任务？"
      :message="`${pendingConfirm.job.groupTitle} · ${pendingConfirm.job.label}`"
      confirm-text="删除"
      danger
      :checkbox="pendingConfirm.job.state === 'done' ? '同时删除视频文件' : ''"
      @confirm="(checked) => { removeJob(pendingConfirm!.job!, checked); pendingConfirm = null }"
      @cancel="pendingConfirm = null"
    />
    <ConfirmDialog
      v-else-if="pendingConfirm?.group"
      title="删除整组任务？"
      :message="`${pendingConfirm.group.title} · ${pendingConfirm.group.ids.length} 个任务`"
      confirm-text="删除整组"
      danger
      checkbox="同时删除已下载的文件"
      @confirm="(checked) => { removeGroup(pendingConfirm!.group!.ids, checked); pendingConfirm = null }"
      @cancel="pendingConfirm = null"
    />
  </div>
</template>

<style scoped>
.head { display: flex; align-items: flex-end; gap: 32px; flex-wrap: wrap; }
.stats { display: flex; gap: 28px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat b { font-family: var(--font-display); font-size: 28px; font-weight: 800; line-height: 1; }
.stat span { font-size: 13px; color: var(--ink-3); }
.run { color: var(--orange-text); }
.bad { color: var(--err); }
.good { color: var(--ok); }
.acts { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; }
.small { font-size: 13px; }
.grp { overflow: hidden; }
.gh { min-height: 64px; padding: 10px 18px; display: flex; align-items: center; gap: 14px; }
.gt { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.gtt { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; min-width: 0; }
.gname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gbar { margin-left: auto; display: flex; flex-shrink: 0; align-items: center; gap: 12px; width: min(280px, 32%); }
.gbar .progress { flex-grow: 1; }
.gbar span { flex-shrink: 0; }
.ga { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.fold { transition: transform .12s; }
.fold[aria-expanded="false"] { transform: rotate(-90deg); }
.jobs { border-top: 1px solid var(--line); }
.job {
  min-height: 58px; padding: 8px 18px; display: grid; grid-template-columns: 72px minmax(0, 1fr) minmax(160px, 240px) 104px;
  align-items: center; column-gap: 18px; border-top: 1px solid var(--line);
}
.job:first-child { border-top: 0; }
.lbl { font-size: 14px; font-weight: 500; }
.st { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.status-line { display: flex; align-items: baseline; gap: 8px; }
.completed-at { font-size: 12px; white-space: nowrap; }
.stt { font-size: 14px; font-weight: 700; }
.stt.done { color: var(--ok); }
.stt.failed { color: var(--err); }
.stt.paused { color: var(--ink-3); }
.stt.queued { color: var(--ink-3); font-weight: 500; }
.sub { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { display: flex; align-items: center; gap: 10px; }
.progress.pause > div { background: var(--ink-3); }
.pc { width: 38px; text-align: right; }
.ja { display: flex; gap: 6px; justify-content: flex-end; }
.del:hover:not(:disabled) { border-color: var(--err); color: var(--err); }
@media (max-width: 1200px) {
  .gbar { width: 200px; }
  .job { grid-template-columns: 66px minmax(0, 1fr) minmax(120px, 180px) 104px; column-gap: 12px; }
}
</style>
