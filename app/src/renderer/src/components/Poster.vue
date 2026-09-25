<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ url?: string; provider?: string; title?: string; titleSize?: number }>(), {
  url: '',
  provider: '',
  title: '',
  titleSize: 18,
})

const COLORS = ['#2b3a55', '#7a2e2e', '#3e5c3a', '#5b4a7a', '#8a5a1f', '#2f5f66', '#4a4a4a', '#6b2e4f']
const failed = ref(false)
watch(
  () => props.url,
  () => (failed.value = false),
)
const src = computed(() =>
  props.url && !failed.value ? `gvs-img://poster/?u=${encodeURIComponent(props.url)}&p=${encodeURIComponent(props.provider)}` : '',
)
const color = computed(() => {
  let h = 0
  for (const c of props.title) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
})
</script>

<template>
  <div class="poster" :style="{ background: color }" role="img" :aria-label="title ? `${title} 海报` : '海报'">
    <img v-if="src" :src="src" alt="" loading="lazy" decoding="async" @error="failed = true" />
    <span v-else-if="title" class="t" :style="{ fontSize: titleSize + 'px' }">{{ title }}</span>
  </div>
</template>

<style scoped>
.poster {
  position: relative; overflow: hidden; border-radius: 8px; flex-shrink: 0; color: #fff;
  display: flex; flex-direction: column; justify-content: flex-end; padding: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.t { font-weight: 900; line-height: 1.15; text-wrap: balance; word-break: break-word; }
</style>
