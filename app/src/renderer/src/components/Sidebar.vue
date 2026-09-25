<script setup lang="ts">
import { computed } from 'vue'
import { PROVIDER_NAME } from '@shared/api'
import mark from '../assets/gvs-mark.svg'
import { go, gvs, store, type View } from '../store'
import Icon from './Icon.vue'
import PlatformLogo from './PlatformLogo.vue'

const nav: Array<{ view: View; label: string; icon: string; also?: View[] }> = [
  { view: 'discover', label: '发现', icon: 'compass' },
  { view: 'search', label: '搜索', icon: 'search', also: ['detail', 'quality'] },
  { view: 'downloads', label: '下载', icon: 'download' },
  { view: 'settings', label: '设置', icon: 'gear' },
]

const active = (n: (typeof nav)[number]) => store.view === n.view || !!n.also?.includes(store.view)
const activeJobs = computed(() => store.jobs.filter((j) => j.state === 'running' || j.state === 'queued').length)
const toneColor: Record<string, string> = { ok: 'var(--side-ok)', warn: 'var(--side-warn)', err: '#ff8a7a', muted: 'var(--side-muted)' }
const host = computed(() => {
  try {
    return new URL(store.state?.settings.host ?? '').host
  } catch {
    return store.state?.settings.host ?? ''
  }
})
const tunnel = computed(() => {
  const t = store.state?.tunnel
  if (!t?.enabled) return { color: 'var(--side-muted)', text: '无需隧道' }
  if (t.ok) return { color: 'var(--side-ok)', text: '隧道已连接' }
  return { color: 'var(--side-warn)', text: '隧道重连中…' }
})
</script>

<template>
  <aside class="side">
    <div class="brand">
      <img :src="mark" alt="" width="34" height="34" />
      <div class="brand-t">
        <span class="name">GVS</span>
        <span class="sub mono">Get Video Streaming</span>
      </div>
    </div>

    <nav aria-label="主导航" class="nav">
      <button v-for="n in nav" :key="n.view" type="button" class="nav-i" :class="{ on: active(n) }" @click="go(n.view)">
        <Icon :name="n.icon" :size="19" />
        <span>{{ n.label }}</span>
        <span v-if="n.view === 'downloads' && activeJobs" class="badge mono">{{ activeJobs }}</span>
      </button>
    </nav>

    <div v-if="store.state?.accounts.length" class="plats">
      <div class="plats-h">平台</div>
      <button
        v-for="a in store.state.accounts"
        :key="a.provider"
        type="button"
        class="plat"
        :title="a.summary"
        @click="go('settings')"
      >
        <PlatformLogo :provider="a.provider" :size="18" />
        <span>{{ PROVIDER_NAME[a.provider] }}</span>
        <span class="st" :style="{ color: toneColor[a.tone] }"><span class="dot" :style="{ background: toneColor[a.tone] }" />{{ a.short }}</span>
      </button>
    </div>

    <button v-if="store.update?.status === 'ready'" type="button" class="upd ready" @click="gvs('installUpdate')">
      <Icon name="refresh" :size="16" /><span>新版本 {{ store.update.version }} 已就绪<br /><b>点此重启安装</b></span>
    </button>
    <button v-else-if="store.update?.status === 'downloading'" type="button" class="upd" @click="go('settings')">
      <Icon name="download" :size="16" /><span>正在下载新版本 {{ store.update.percent }}%</span>
    </button>
    <button v-else-if="store.update?.status === 'available'" type="button" class="upd" @click="go('settings')">
      <Icon name="download" :size="16" /><span>有新版本 {{ store.update.version }}</span>
    </button>

    <div class="gw" :class="{ tight: store.update && ['ready', 'downloading', 'available'].includes(store.update.status) }">
      <div class="gw-row">
        <span class="dot" :style="{ background: tunnel.color }" />
        <span>{{ tunnel.text }}</span>
      </div>
      <div class="gw-host mono" :title="store.state?.settings.host">{{ host || '未连接网关' }}</div>
    </div>
  </aside>
</template>

<style scoped>
.side {
  width: 232px; height: 100%; flex-shrink: 0; background: var(--side); color: var(--side-fg);
  padding: 22px 14px 18px; display: flex; flex-direction: column; gap: 24px; overflow-y: auto;
}
.brand { display: flex; align-items: center; gap: 11px; padding: 0 6px; }
.brand-t { display: flex; flex-direction: column; gap: 2px; }
.name { font-family: var(--font-display); font-size: 22px; font-weight: 800; letter-spacing: .5px; line-height: 1; }
.sub { font-size: 11px; color: var(--side-muted); }
.nav { display: flex; flex-direction: column; gap: 4px; }
.nav-i {
  height: 44px; padding: 0 14px; border-radius: 8px; border: 0; background: transparent; color: var(--side-fg);
  display: flex; align-items: center; gap: 12px; font-size: 15px; font-weight: 500; cursor: pointer; text-align: left;
}
.nav-i:hover { background: var(--side-2); }
.nav-i.on { background: var(--orange); color: var(--ink); font-weight: 700; }
.badge {
  margin-left: auto; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px; background: var(--orange);
  color: var(--ink); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.nav-i.on .badge { background: var(--ink); color: var(--paper); }
.plats { display: flex; flex-direction: column; gap: 2px; }
.plats-h { padding: 0 14px 6px; font-size: 12px; color: var(--side-muted); letter-spacing: 1px; }
.plat {
  height: 34px; padding: 0 14px; display: flex; align-items: center; gap: 10px; font-size: 14px;
  background: transparent; border: 0; color: var(--side-fg); border-radius: 6px; cursor: pointer; text-align: left;
}
.plat:hover { background: var(--side-2); }
.st { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.st .dot { width: 6px; height: 6px; }
.upd {
  margin-top: auto; padding: 10px 14px; border-radius: 8px; border: 1.5px solid var(--orange); background: transparent;
  color: var(--side-fg); display: flex; align-items: center; gap: 10px; font-size: 13px; line-height: 1.5; text-align: left; cursor: pointer;
}
.upd.ready { background: var(--orange); color: var(--ink); border-color: var(--orange); }
.upd:hover { filter: brightness(1.08); }
.gw.tight { margin-top: 0; }
.gw { margin-top: auto; padding: 12px 14px; border-radius: 8px; background: var(--side-2); display: flex; flex-direction: column; gap: 6px; }
.gw-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.gw-host { font-size: 12px; color: var(--side-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
