<script setup lang="ts">
import { computed } from 'vue'
import type { JobView } from '@shared/api'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import Poster from '../components/Poster.vue'
import { errText, gvs, store, toast } from '../store'

const counts = computed(() => {
  const c = { running: 0, queued: 0, failed: 0, done: 0 }
  for (const j of store.jobs) c[j.state]++
  return c
})

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

const barClass = (j: JobView) =>
  j.state === 'done' ? 'done' : j.state === 'failed' ? 'fail' : /封装|合并|mux|remux/i.test(j.status) ? 'mux' : ''
const pct = (j: JobView) => Math.round((j.state === 'done' ? 1 : j.pct) * 100)
const sub = (j: JobView) => (j.state === 'failed' ? j.err : j.state === 'done' ? j.note || j.output : j.log)

async function call(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (e) {
    toast(errText(e), 'err')
  }
}
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="h1">下载</h1>
      <div class="stats">
        <div class="stat"><b class="run">{{ counts.running }}</b><span>进行中</span></div>
        <div class="stat"><b>{{ counts.queued }}</b><span>排队</span></div>
        <div class="stat"><b class="bad">{{ counts.failed }}</b><span>失败</span></div>
        <div class="stat"><b class="good">{{ counts.done }}</b><span>已完成</span></div>
      </div>
      <div class="acts">
        <button type="button" class="btn" :disabled="!counts.done" @click="call(() => gvs('clearFinished'))"><Icon name="trash" :size="16" />清除已完成</button>
        <button type="button" class="btn" @click="call(() => gvs('openPath', ''))"><Icon name="folder" :size="16" />打开下载目录</button>
      </div>
    </div>

    <div v-if="!groups.length" class="empty card">
      <Icon name="download" :size="28" />
      <span>还没有下载任务。搜一部剧，选好集数和画质就能开始。</span>
    </div>

    <section v-for="g in groups" :key="g.id" class="card grp">
      <div class="gh">
        <Poster :url="g.poster" :provider="g.provider" style="width: 34px; height: 48px; padding: 0" />
        <div class="gt">
          <div class="gtt"><PlatformLogo :provider="g.provider" :size="16" /><span>{{ g.title }}</span></div>
          <span class="muted small">{{ g.jobs.length }} 个任务 · {{ g.quality }}</span>
        </div>
        <span class="mono dim small gprog">{{ g.jobs.filter((j) => j.state === 'done').length }} / {{ g.jobs.length }} 完成</span>
      </div>
      <div v-for="j in g.jobs" :key="j.id" class="job">
        <span class="mono lbl">{{ j.label }}</span>
        <div class="st">
          <span class="stt" :class="j.state">{{ j.state === 'queued' ? '排队中' : j.status }}</span>
          <span class="muted sub" :title="sub(j)">{{ sub(j) }}</span>
        </div>
        <div class="bar">
          <div class="progress" :class="barClass(j)"><div :style="{ width: pct(j) + '%' }" /></div>
          <span class="mono small dim pc">{{ pct(j) }}%</span>
        </div>
        <div class="ja">
          <button v-if="j.state === 'failed'" type="button" class="btn sm" @click="call(() => gvs('retryJob', j.id))"><Icon name="retry" :size="15" />重试</button>
          <button v-if="j.state === 'done' && j.output" type="button" class="btn sm icon" aria-label="打开所在文件夹" title="打开所在文件夹" @click="call(() => gvs('showItem', j.output))"><Icon name="folder" :size="16" /></button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: flex-end; gap: 36px; flex-wrap: wrap; }
.stats { display: flex; gap: 32px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat b { font-family: var(--font-display); font-size: 28px; font-weight: 800; line-height: 1; }
.stat span { font-size: 13px; color: var(--ink-3); }
.run { color: var(--orange-text); }
.bad { color: var(--err); }
.good { color: var(--ok); }
.acts { margin-left: auto; display: flex; gap: 8px; }
.small { font-size: 13px; }
.grp { overflow: hidden; }
.gh { height: 64px; padding: 0 18px; display: flex; align-items: center; gap: 14px; }
.gt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.gtt { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; }
.gprog { margin-left: auto; }
.job {
  min-height: 58px; padding: 8px 18px; display: grid; grid-template-columns: 72px minmax(0, 1fr) 240px 96px;
  align-items: center; column-gap: 18px; border-top: 1px solid var(--line);
}
.lbl { font-size: 14px; font-weight: 500; }
.st { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.stt { font-size: 14px; font-weight: 700; }
.stt.done { color: var(--ok); }
.stt.failed { color: var(--err); }
.stt.queued { color: var(--ink-3); font-weight: 500; }
.sub { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { display: flex; align-items: center; gap: 10px; }
.pc { width: 38px; text-align: right; }
.ja { display: flex; gap: 6px; justify-content: flex-end; }
</style>
