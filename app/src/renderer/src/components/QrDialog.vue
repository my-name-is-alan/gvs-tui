<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { QRPoll, QRStart } from '@shared/api'
import { errText, gvs, store, toast } from '../store'
import Icon from './Icon.vue'
import PlatformLogo from './PlatformLogo.vue'

const kind = store.qr!
const start = ref<QRStart | null>(null)
const status = ref<QRPoll>({ done: false, message: '正在获取二维码…', tone: 'muted' })
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null
let busy = false

async function load() {
  stop()
  error.value = ''
  start.value = null
  status.value = { done: false, message: '正在获取二维码…', tone: 'muted' }
  try {
    start.value = kind === 'youku' ? await gvs('youkuQrStart') : await gvs('tencentQrStart')
    status.value = { done: false, message: '等待扫码…', tone: 'muted' }
    timer = setInterval(poll, kind === 'youku' ? 1500 : 3500)
  } catch (e) {
    error.value = errText(e)
  }
}

async function poll() {
  if (busy) return
  busy = true
  try {
    const r = kind === 'youku' ? await gvs('youkuQrPoll') : await gvs('tencentQrPoll')
    status.value = r
    if (r.done) {
      stop()
      toast(r.message, 'ok')
      close()
    } else if (r.tone === 'warn') stop()
  } catch (e) {
    status.value = { done: false, message: errText(e), tone: 'warn' }
  } finally {
    busy = false
  }
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

function close() {
  stop()
  void gvs('qrCancel')
  store.qr = null
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  void load()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stop()
})
</script>

<template>
  <div class="scrim" @click.self="close">
    <div class="dlg" role="dialog" aria-modal="true" :aria-label="kind === 'youku' ? '扫码登录优酷' : '扫码登录腾讯视频'">
      <div class="head">
        <PlatformLogo :provider="kind" :size="26" />
        <h1 class="title">{{ kind === 'youku' ? '扫码登录优酷' : '扫码登录腾讯视频' }}</h1>
        <button type="button" class="btn sm icon" aria-label="关闭" @click="close"><Icon name="x" :size="16" /></button>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-else-if="!start" class="loading"><span class="spin" /> 正在获取二维码…</div>
      <div v-else class="codes" :class="{ two: start.images.length > 1 }">
        <figure v-for="img in start.images" :key="img.title" class="code">
          <div class="frame"><img :src="img.image" :alt="img.title + ' 二维码'" /></div>
          <figcaption v-if="start.images.length > 1">{{ img.title }}</figcaption>
        </figure>
      </div>

      <div v-if="start" class="status" :class="status.tone">
        <span v-if="status.tone === 'muted'" class="spin" />
        {{ status.message }}
      </div>
      <p v-if="start" class="hint">{{ start.hint }}</p>

      <div class="foot">
        <button type="button" class="btn sm" @click="load"><Icon name="refresh" :size="15" />刷新二维码</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; background: rgba(23, 24, 28, 0.45); display: flex; align-items: center; justify-content: center; z-index: 40; }
.dlg {
  width: 480px; max-width: calc(100vw - 48px); background: var(--paper); border: 1.5px solid var(--ink); border-radius: 12px;
  box-shadow: 8px 8px 0 var(--ink); padding: 26px; display: flex; flex-direction: column; align-items: center; gap: 18px;
}
.dlg:has(.two) { width: 640px; }
.head { align-self: stretch; display: flex; align-items: center; gap: 10px; }
.title { font-size: 21px; font-weight: 700; }
.head .btn { margin-left: auto; }
.loading { height: 240px; display: flex; align-items: center; gap: 10px; color: var(--ink-2); }
.codes { display: flex; gap: 24px; }
.code { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.frame { padding: 14px; background: var(--card); border: 1.5px solid var(--ink); border-radius: 12px; box-shadow: 6px 6px 0 var(--orange); }
.frame img { width: 220px; height: 220px; display: block; image-rendering: pixelated; }
figcaption { font-size: 14px; font-weight: 700; }
.status { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 500; }
.status.ok { color: var(--ok); }
.status.warn { color: var(--orange-text); }
.hint { font-size: 14px; color: var(--ink-2); text-align: center; line-height: 1.6; }
.foot { align-self: stretch; display: flex; justify-content: flex-end; }
.error-box { align-self: stretch; }
</style>
