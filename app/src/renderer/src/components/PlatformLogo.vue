<script setup lang="ts">
import youku from '../assets/platforms/youku.svg'
import tencent from '../assets/platforms/tencent.svg'
import hongguo from '../assets/platforms/hongguo.svg'
import douyin from '../assets/platforms/douyin.svg'

withDefaults(defineProps<{ provider: string; size?: number }>(), { size: 18 })
const LOGOS: Record<string, string> = { youku, tencent, hongguo, douyin }
</script>

<template>
  <img
    v-if="LOGOS[provider]"
    :src="LOGOS[provider]"
    alt=""
    :width="size"
    :height="size"
    class="plogo"
    :style="{ width: size + 'px', height: size + 'px' }"
  />
  <!-- 黄果没有官方图标，用字标 -->
  <span v-else class="plogo text" aria-hidden="true" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.6) + 'px' }">黄</span>
</template>

<style scoped>
.plogo { border-radius: 4px; flex-shrink: 0; display: block; }
.plogo.text { background: #f2b705; color: var(--ink); font-weight: 900; display: flex; align-items: center; justify-content: center; }
</style>
