<script setup lang="ts">
// 原「设置 → 平台账号」里优酷 / 腾讯 / 抖音 / IQ Cookie 的操作，按平台拆出来放进账号抽屉。
import { computed, ref, watch } from 'vue'
import type { SettingsPatch } from '@shared/api'
import TencentDiagnostics from './TencentDiagnostics.vue'
import Icon from './Icon.vue'
import { errText, gvs, store, toast } from '../store'

const props = defineProps<{ provider: string }>()
const s = computed(() => store.state!.settings)
const saving = ref('')
const diagnosticsOpen = ref(false)
const iqCookieSource = ref<'auto' | 'domestic' | 'international'>('auto')
const form = ref({ tencentCookie: '', douyinCookie: '', iqCookie: '', iqProfile: '' })
watch(() => [props.provider, s.value.iqProfile] as const, () => {
  form.value = { tencentCookie: '', douyinCookie: '', iqCookie: '', iqProfile: s.value.iqProfile }
}, { immediate: true })

// 腾讯原生手机号登录：发码前弹官方图形验证窗口（主进程处理），用户本人过验后网关发短信。
const txSmsArea = ref('+86')
const txSmsPhone = ref('')
const txSmsCode = ref('')
const smsBusy = ref(false)
const smsNote = ref('')
const validPhone = computed(() => /^\+?\d{6,20}$/.test(txSmsPhone.value.trim()))

async function smsSend() {
  smsBusy.value = true
  smsNote.value = ''
  try {
    const r = await gvs('tencentNativeSmsStart', txSmsPhone.value.trim(), txSmsArea.value)
    smsNote.value = r.sent ? '验证码已发送，请查收短信' : (r.message || '未发送')
  } catch (e) {
    smsNote.value = errText(e)
  } finally {
    smsBusy.value = false
  }
}
async function smsSubmit() {
  smsBusy.value = true
  smsNote.value = ''
  try {
    const r = await gvs('tencentNativeSmsSubmit', txSmsCode.value.trim())
    if (r.done) {
      txSmsPhone.value = ''
      txSmsCode.value = ''
      smsNote.value = ''
      toast('腾讯手机号登录成功', 'ok')
    } else {
      smsNote.value = r.message || '登录未完成'
    }
  } catch (e) {
    smsNote.value = errText(e)
  } finally {
    smsBusy.value = false
  }
}

async function save(patch: SettingsPatch, what: string) {
  saving.value = what
  try {
    store.state = await gvs('saveSettings', patch)
    toast('已保存', 'ok')
    if ('tencentCookie' in patch) form.value.tencentCookie = ''
    if ('douyinCookie' in patch) form.value.douyinCookie = ''
    if ('iqCookie' in patch) form.value.iqCookie = ''
  } catch (e) {
    toast(errText(e), 'err')
  } finally {
    saving.value = ''
  }
}
async function renew() {
  saving.value = 'renew'
  try { toast(await gvs('youkuRenew'), 'ok') } catch (e) { toast(errText(e), 'err') } finally { saving.value = '' }
}
</script>

<template>
  <div v-if="provider === 'youku'" class="blk">
    <p>用优酷 App 扫码登录；登录态由网关按 Key 保存，过期前可续期。</p>
    <div class="controls">
      <button type="button" class="btn sm" @click="store.qr = 'youku'"><Icon name="qr" :size="15" />扫码登录</button>
      <button type="button" class="btn sm" :disabled="saving === 'renew'" @click="renew"><span v-if="saving === 'renew'" class="spin" />续期</button>
    </div>
  </div>

  <div v-else-if="provider === 'tencent'" class="blk">
    <p>推荐双扫码（微信 + QQ 任一）登录；也可粘贴网页 Cookie，推送到网关托管，本机不保存。</p>
    <div class="controls">
      <button type="button" class="btn sm" @click="store.qr = 'tencent'"><Icon name="qr" :size="15" />双扫码</button>
      <button type="button" class="btn sm" @click="diagnosticsOpen = true">风控处理日志</button>
    </div>
    <details>
      <summary>手机号登录（原生短信）</summary>
      <p>用本人手机号收短信登录，取原生 App 票据；发码前会弹官方图形验证窗口，需本人过验。</p>
      <div class="controls">
        <select v-model="txSmsArea" class="input" aria-label="手机区号" style="width: 88px">
          <option value="+86">+86</option>
          <option value="+852">+852</option>
          <option value="+853">+853</option>
          <option value="+886">+886</option>
        </select>
        <input v-model="txSmsPhone" class="input" inputmode="tel" autocomplete="off" placeholder="手机号" aria-label="本人手机号" />
        <button type="button" class="btn sm" :disabled="smsBusy || !validPhone" @click="smsSend">获取验证码</button>
      </div>
      <div class="controls">
        <input v-model="txSmsCode" class="input" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="短信验证码" aria-label="短信验证码" />
        <button type="button" class="btn sm" :disabled="smsBusy || !/^\d{4,8}$/.test(txSmsCode)" @click="smsSubmit">登录</button>
      </div>
      <p v-if="smsNote">{{ smsNote }}</p>
    </details>
    <details>
      <summary>粘贴网页 Cookie</summary>
      <textarea v-model="form.tencentCookie" class="input" spellcheck="false" placeholder="粘贴腾讯视频网页 Cookie" />
      <button type="button" class="btn sm" :disabled="!form.tencentCookie.trim() || saving === 'tx'" @click="save({ tencentCookie: form.tencentCookie }, 'tx')">保存 Cookie</button>
    </details>
    <TencentDiagnostics v-if="diagnosticsOpen" @close="diagnosticsOpen = false" />
  </div>

  <div v-else-if="provider === 'douyin'" class="blk">
    <p>网页登录 Cookie（需含 sessionid），推送到网关号池托管。</p>
    <textarea v-model="form.douyinCookie" class="input" spellcheck="false" placeholder="网页登录 Cookie（需含 sessionid）" />
    <button type="button" class="btn sm" :disabled="!form.douyinCookie.trim() || saving === 'dy'" @click="save({ douyinCookie: form.douyinCookie }, 'dy')">保存 Cookie</button>
  </div>

  <div v-else-if="provider === 'iq'" class="blk">
    <details>
      <summary>IQ / 国内爱奇艺 Cookie 会话</summary>
      <label for="iq-cookie-source">Cookie 来源</label>
      <select id="iq-cookie-source" v-model="iqCookieSource" class="input">
        <option value="auto">自动识别 Netscape 域名；Header 按海外 IQ</option>
        <option value="domestic">国内爱奇艺（iqiyi.com）</option>
        <option value="international">海外 IQ（iq.com）</option>
      </select>
      <p>国内与海外会话分别保存。国内 Cookie 用于国内 Web/Puma 取流，是否可播放由源站确认。</p>
      <textarea v-model="form.iqCookie" class="input" spellcheck="false" placeholder="Cookie Header 或 Netscape 格式内容" />
      <button type="button" class="btn sm" :disabled="!form.iqCookie.trim() || saving === 'iq'" @click="save({ iqCookie: form.iqCookie, iqCookieSource }, 'iq')">保存会话</button>
      <label for="iq-cdn">视频 CDN 偏好</label>
      <select id="iq-cdn" class="input" :value="s.iqCdn || 'auto'" :disabled="saving === 'iq-cdn'" @change="save({ iqCdn: ($event.target as HTMLSelectElement).value as SettingsPatch['iqCdn'] }, 'iq-cdn')">
        <option value="auto">自动测速</option>
        <option value="akamai">Akamai</option>
        <option value="bscloud">BSCloud</option>
        <option value="zenlayer">Zenlayer</option>
      </select>
      <p>优先使用所选节点；源站未提供该文件的节点或节点失败时，自动切换可用节点。</p>
      <textarea v-model="form.iqProfile" class="input" spellcheck="false" placeholder="设备资料 JSON：deviceId、ccsn（网关已配置设备证书时可留空）" />
      <button type="button" class="btn sm" :disabled="saving === 'iq-profile'" @click="save({ iqProfile: form.iqProfile }, 'iq-profile')">保存设备资料</button>
    </details>
  </div>

  <div v-else-if="provider === 'hongguo' || provider === 'huangguo'" class="blk">
    <p>公开接口，不需要账号。</p>
  </div>
</template>

<style scoped>
.blk { display: flex; flex-direction: column; gap: 10px; padding-bottom: 6px; }
p { font-size: 12px; line-height: 1.65; color: var(--ink-2); margin: 0; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; }
details { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
details > * + * { margin-top: 8px; }
summary { cursor: pointer; color: var(--ink-2); }
textarea { min-height: 80px; width: 100%; }
</style>
