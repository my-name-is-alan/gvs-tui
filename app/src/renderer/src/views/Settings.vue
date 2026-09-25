<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { PROVIDER_NAME, type SettingsPatch } from '@shared/api'
import Icon from '../components/Icon.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import { errText, gvs, hasProvider, store, toast } from '../store'

const s = computed(() => store.state!.settings)
const form = reactive({
  host: '',
  key: '',
  outDir: '',
  releaseGroup: '',
  tmdbKey: '',
  tmdbLang: '',
  threads: 4,
  tencentCookie: '',
  douyinCookie: '',
  hongguoNfo: true,
  huangguoNfo: true,
  hongguoFmt: 'mkv',
  huangguoFmt: 'mkv',
})
function reset() {
  Object.assign(form, { ...s.value, key: '' })
}
watch(() => store.state?.settings, reset, { immediate: true })

const saving = ref('')
async function save(patch: SettingsPatch, what: string) {
  saving.value = what
  try {
    store.state = await gvs('saveSettings', patch)
    toast('已保存', 'ok')
  } catch (e) {
    toast(errText(e), 'err')
    reset()
  } finally {
    saving.value = ''
  }
}

async function pickDir() {
  const dir = await gvs('chooseDir')
  if (dir) await save({ outDir: dir }, 'dir')
}

async function renew() {
  saving.value = 'renew'
  try {
    toast(await gvs('youkuRenew'), 'ok')
  } catch (e) {
    toast(errText(e), 'err')
  } finally {
    saving.value = ''
  }
}

function step(d: number) {
  form.threads = Math.min(16, Math.max(1, form.threads + d))
  void save({ threads: form.threads }, 'threads')
}

const upd = computed(() => store.update)
const updText = computed(() => {
  const u = upd.value
  if (!u) return '未检查'
  switch (u.status) {
    case 'checking': return '检查中…'
    case 'latest': return '已是最新'
    case 'available': return `新版本 ${u.version}`
    case 'downloading': return `下载中 ${u.percent}%`
    case 'ready': return `${u.version} 已就绪`
    case 'error': return `检查失败：${u.message.slice(0, 60)}`
    default: return '未检查'
  }
})
const updTone = computed(() => {
  const s = upd.value?.status
  return s === 'ready' || s === 'latest' ? 'ok' : s === 'available' || s === 'downloading' ? 'warn' : s === 'error' ? 'err' : ''
})
async function checkUpdate() {
  try {
    store.update = await gvs('checkUpdate')
  } catch (e) {
    toast(errText(e), 'err')
  }
}

const account = (p: string) => store.state?.accounts.find((a) => a.provider === p)
const tone: Record<string, string> = { ok: 'ok', warn: 'warn', err: 'err', muted: '' }
const onSystemDrive = computed(() => store.state?.platform === 'win32' && /^c:[\\/]/i.test(form.outDir))
const tunnelText = computed(() => {
  const t = store.state!.tunnel
  if (!t.enabled) return { cls: '', text: '无需隧道' }
  return t.ok ? { cls: 'ok', text: '隧道正常' } : { cls: 'warn', text: t.err ? `隧道：${t.err}` : '隧道连接中' }
})
</script>

<template>
  <div class="page">
    <h1 class="h1">设置</h1>
    <div class="cols">
      <div class="col">
        <section class="card pad sec">
          <h2 class="h2s">网关</h2>
          <label class="field">网关地址<input v-model="form.host" class="input mono" autocomplete="off" /></label>
          <label class="field">API Key
            <input v-model="form.key" class="input mono" :placeholder="s.keyMasked || 'sk_live_…'" autocomplete="off" />
          </label>
          <div class="row">
            <span class="chip ok">{{ store.state!.keyName || '已连接' }}</span>
            <span class="chip" :class="tunnelText.cls">{{ tunnelText.text }}</span>
            <button
              type="button"
              class="btn sm"
              style="margin-left: auto"
              :disabled="saving === 'gw' || (form.host === s.host && !form.key)"
              @click="save({ host: form.host, key: form.key || undefined }, 'gw')"
            >
              <span v-if="saving === 'gw'" class="spin" />保存并重连
            </button>
          </div>
        </section>

        <section class="card pad sec">
          <h2 class="h2s">外观</h2>
          <div class="font">
            <span class="big">字</span>
            <span class="dim small">界面字体随应用一起安装，不依赖系统字体，旧版 Win10 也不会缺字。</span>
          </div>
        </section>

        <section class="card pad sec">
          <h2 class="h2s">媒体工具</h2>
          <div v-for="t in store.state!.tools" :key="t.name" class="tool">
            <Icon :name="t.ok ? 'check' : 'x'" :size="16" :stroke="2.5" :style="{ color: t.ok ? 'var(--ok)' : 'var(--err)' }" />
            <span class="tn">{{ t.name }}</span>
            <span class="muted small" style="margin-left: auto">{{ t.note }}</span>
          </div>
          <div v-if="!store.state!.tools.length" class="muted small row"><span class="spin" />检查中…</div>
        </section>

        <section class="card pad sec">
          <h2 class="h2s">关于与更新</h2>
          <div class="row">
            <span>GVS <b class="mono">{{ store.state!.version }}</b></span>
            <span class="chip" :class="updTone">{{ updText }}</span>
          </div>
          <div v-if="upd?.status === 'downloading'" class="progress"><div :style="{ width: upd.percent + '%' }" /></div>
          <div class="row">
            <button type="button" class="btn sm" :disabled="upd?.status === 'checking' || upd?.status === 'downloading'" @click="checkUpdate">
              <span v-if="upd?.status === 'checking'" class="spin" />检查更新
            </button>
            <button v-if="upd?.status === 'ready'" type="button" class="btn sm outline" @click="gvs('installUpdate')">立即重启安装</button>
            <button v-else-if="upd?.status === 'available' && upd.url" type="button" class="btn sm outline" @click="gvs('installUpdate')">前往下载</button>
          </div>
          <span class="muted small">{{ upd?.auto ? '有新版本会自动下载，下次退出时安装。' : '有新版本时会在这里提示。' }}</span>
        </section>
      </div>

      <div class="col">
        <section class="card pad sec">
          <h2 class="h2s">平台账号</h2>
          <div v-if="hasProvider('youku')" class="acct">
            <div class="ah">
              <PlatformLogo provider="youku" :size="24" /><b>{{ PROVIDER_NAME.youku }}</b>
              <span class="chip" :class="tone[account('youku')?.tone ?? 'muted']">{{ account('youku')?.short }}</span>
              <div class="aa">
                <button type="button" class="btn sm" :disabled="saving === 'renew'" @click="renew">续期</button>
                <button type="button" class="btn sm" @click="store.qr = 'youku'"><Icon name="qr" :size="15" />扫码</button>
              </div>
            </div>
            <span class="muted small">{{ account('youku')?.summary }}</span>
          </div>
          <div v-if="hasProvider('tencent')" class="acct">
            <div class="ah">
              <PlatformLogo provider="tencent" :size="24" /><b>{{ PROVIDER_NAME.tencent }}</b>
              <span class="chip" :class="tone[account('tencent')?.tone ?? 'muted']">{{ account('tencent')?.short }}</span>
              <div class="aa"><button type="button" class="btn sm" @click="store.qr = 'tencent'"><Icon name="qr" :size="15" />双扫码</button></div>
            </div>
            <span class="muted small">{{ account('tencent')?.summary }}</span>
            <label class="field">或粘贴 Cookie<textarea v-model="form.tencentCookie" class="input" spellcheck="false" /></label>
            <div class="row end">
              <button type="button" class="btn sm" :disabled="form.tencentCookie === s.tencentCookie" @click="save({ tencentCookie: form.tencentCookie }, 'tx')">保存 Cookie</button>
            </div>
          </div>
          <div v-for="p in (['hongguo', 'huangguo'] as const).filter(hasProvider)" :key="p" class="acct">
            <div class="ah"><PlatformLogo :provider="p" :size="24" /><b>{{ PROVIDER_NAME[p] }}</b><span class="chip">无需登录</span></div>
          </div>
          <div v-if="hasProvider('douyin')" class="acct">
            <div class="ah">
              <PlatformLogo provider="douyin" :size="24" /><b>{{ PROVIDER_NAME.douyin }}</b>
              <span class="chip" :class="tone[account('douyin')?.tone ?? 'muted']">{{ account('douyin')?.short }}</span>
            </div>
            <label class="field">网页登录 Cookie（需含 sessionid）<textarea v-model="form.douyinCookie" class="input" spellcheck="false" /></label>
            <div class="row end">
              <button type="button" class="btn sm" :disabled="form.douyinCookie === s.douyinCookie" @click="save({ douyinCookie: form.douyinCookie }, 'dy')">保存 Cookie</button>
            </div>
          </div>
        </section>
      </div>

      <div class="col">
        <section class="card pad sec">
          <h2 class="h2s">下载</h2>
          <div class="row bottom">
            <label class="field grow">保存到<input :value="form.outDir" class="input mono" readonly @click="pickDir" /></label>
            <button type="button" class="btn" @click="pickDir">更改…</button>
          </div>
          <span class="muted small">没配过时，Windows 会选空间最大的非系统盘，目录是该盘下的 GVS。点「更改」可以换成任意文件夹。</span>
          <span v-if="onSystemDrive" class="muted small" style="color: var(--orange-text)">当前在系统盘，大文件容易把系统盘占满。</span>
          <div class="row bottom">
            <div class="field grow">
              <span>分片并发</span>
              <div class="stepper">
                <button type="button" aria-label="减少" @click="step(-1)">−</button>
                <span class="mono">{{ form.threads }}</span>
                <button type="button" aria-label="增加" @click="step(1)">+</button>
              </div>
            </div>
            <label class="field grow">发布组
              <input v-model="form.releaseGroup" class="input" @change="save({ releaseGroup: form.releaseGroup }, 'rg')" />
            </label>
          </div>
          <label v-if="hasProvider('hongguo')" class="toggle">红果写入 NFO
            <input v-model="form.hongguoNfo" type="checkbox" @change="save({ hongguoNfo: form.hongguoNfo }, 'hn')" />
            <span class="track"><span class="knob" /></span>
          </label>
          <label v-if="hasProvider('huangguo')" class="toggle">黄果写入 NFO
            <input v-model="form.huangguoNfo" type="checkbox" @change="save({ huangguoNfo: form.huangguoNfo }, 'yn')" />
            <span class="track"><span class="knob" /></span>
          </label>
        </section>

        <section class="card pad sec">
          <h2 class="h2s">TMDB 刮削</h2>
          <span class="muted small">填了 Key，优酷/腾讯下载时会自动匹配 TMDB，按 Jellyfin/Plex 的习惯命名。</span>
          <label class="field">API Key<input v-model="form.tmdbKey" class="input mono" autocomplete="off" @change="save({ tmdbKey: form.tmdbKey }, 'tk')" /></label>
          <label class="field">语言<input v-model="form.tmdbLang" class="input mono" @change="save({ tmdbLang: form.tmdbLang }, 'tl')" /></label>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.sec { display: flex; flex-direction: column; gap: 14px; }
.h2s { font-size: 17px; font-weight: 700; }
.small { font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.end { justify-content: flex-end; }
.row.bottom { align-items: flex-end; flex-wrap: nowrap; }
.grow { flex-grow: 1; min-width: 0; }
.font { padding: 12px 14px; background: var(--paper); border-radius: 8px; display: flex; gap: 12px; align-items: center; }
.big { font-family: var(--font-display); font-size: 26px; font-weight: 800; line-height: 1; }
.tool { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.tn { font-weight: 500; }
.acct { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--line); }
.acct:first-of-type { border-top: 0; padding-top: 0; }
.ah { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.aa { margin-left: auto; display: flex; gap: 6px; }
.stepper { height: 40px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); display: flex; align-items: center; }
.stepper button { width: 40px; height: 38px; border: 0; background: transparent; font-size: 18px; cursor: pointer; }
.stepper span { flex-grow: 1; text-align: center; font-size: 15px; }
@media (max-width: 1280px) {
  .cols { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
