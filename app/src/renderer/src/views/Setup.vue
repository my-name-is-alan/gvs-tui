<script setup lang="ts">
import { ref } from 'vue'
import mark from '../assets/gvs-mark.svg'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import { errText, gvs, store } from '../store'

const host = ref(store.state?.settings.host || 'https://')
const key = ref('')
const busy = ref(false)
const error = ref(store.state?.keyError ?? '')

async function connect() {
  busy.value = true
  error.value = ''
  try {
    store.state = await gvs('setup', host.value, key.value)
  } catch (e) {
    error.value = errText(e)
  } finally {
    busy.value = false
  }
}

const plats = [
  ['youku', '优酷'],
  ['tencent', '腾讯'],
  ['hongguo', '红果'],
  ['huangguo', '黄果'],
  ['douyin', '抖音'],
]
</script>

<template>
  <div class="setup">
    <section class="left">
      <div class="logo"><img :src="mark" alt="" width="34" height="34" /><span>GVS</span></div>
      <h1 class="hero">Get Video<br /><span>Streaming</span></h1>
      <p class="tag">一个地方搜遍五个平台，<br />画质和音轨自己挑，文件存在你自己电脑上。</p>
      <div class="plats">
        <div v-for="[p, n] in plats" :key="p" class="plat"><PlatformLogo :provider="p!" :size="26" />{{ n }}</div>
      </div>
    </section>
    <section class="right">
      <form class="card hard form" @submit.prevent="connect">
        <div class="steps">
          <div class="step on"><span class="n mono">1</span>连接网关</div>
          <div class="step"><span class="n mono">2</span>登录平台</div>
          <div class="step"><span class="n mono">3</span>开始下载</div>
        </div>
        <div class="title">
          <h2>连接你的网关</h2>
          <span class="dim">地址和 Key 找网关管理员要，只保存在这台电脑上。</span>
        </div>
        <label class="field strong-label">网关地址
          <input v-model="host" class="input strong mono" placeholder="https://your-gateway.example" autocomplete="off" required />
        </label>
        <label class="field strong-label">API Key
          <input v-model="key" class="input strong mono" placeholder="sk_live_…" autocomplete="off" required />
        </label>
        <div v-if="error" class="error-box">{{ error }}</div>
        <button type="submit" class="btn primary big" :disabled="busy">
          <span v-if="busy" class="spin" />
          <span>{{ busy ? '连接中…' : '连接' }}</span>
          <Icon v-if="!busy" name="arrow" />
        </button>
        <div class="note"><Icon name="check" :size="15" :stroke="2.5" style="color: var(--ok)" />连上后会自动建立隧道，优酷、腾讯请求从本机出网</div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.setup { height: 100%; display: flex; }
.left { width: 44%; max-width: 560px; background: var(--ink); color: var(--paper); padding: 48px; display: flex; flex-direction: column; gap: 28px; }
.logo { display: flex; align-items: center; gap: 12px; font-family: var(--font-display); font-size: 22px; font-weight: 800; }
.hero { margin-top: auto; font-family: var(--font-display); font-size: clamp(52px, 6vw, 76px); font-weight: 800; letter-spacing: -2px; line-height: .95; }
.hero span { color: var(--orange); }
.tag { font-size: 18px; line-height: 1.6; color: #c9c6bd; }
.plats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 18px; }
.plat { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 500; }
.right {
  flex-grow: 1; display: flex; align-items: center; justify-content: center; padding: 48px;
  background-color: var(--paper);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 32px 32px;
}
.form { width: 480px; padding: 36px; border-radius: 12px; box-shadow: 8px 8px 0 var(--ink); display: flex; flex-direction: column; gap: 22px; }
.steps { display: flex; gap: 18px; }
.step { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink-3); }
.step .n { width: 26px; height: 26px; border-radius: 50%; border: 1.5px solid var(--line); font-size: 13px; display: flex; align-items: center; justify-content: center; }
.step.on { color: var(--ink); font-weight: 700; }
.step.on .n { border-color: var(--ink); background: var(--orange); }
.title { display: flex; flex-direction: column; gap: 8px; }
.title h2 { font-size: 28px; font-weight: 900; }
.strong-label { font-size: 14px; font-weight: 500; color: var(--ink); gap: 8px; }
.note { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-3); }
</style>
