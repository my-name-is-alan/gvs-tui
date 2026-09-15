<script setup lang="ts">
// Footer key hints: `⏎ 确认  ·  esc 返回` with the keys in the accent color.
// When the terminal is narrow the low-priority hints are dropped rather than
// letting the line wrap; the trailing hint is always kept.
import { computed } from 'vue-termui'
import { StyledText, Text, fg } from 'vue-termui'
import { c } from '../lib/theme.ts'
import { displayWidth } from '../lib/text.ts'

const props = defineProps<{ hints: Array<[string, string]>; width: number }>()

const SEPARATOR = '  ·  '
const SEPARATOR_CELLS = 5

function measure(hints: Array<[string, string]>): number {
  if (!hints.length) return 0
  const body = hints.reduce((n, [key, label]) => n + displayWidth(key) + 1 + displayWidth(label), 0)
  return body + (hints.length - 1) * SEPARATOR_CELLS
}

const fitted = computed(() => {
  const all = props.hints
  if (measure(all) <= props.width || all.length <= 1) return all
  const tail = all[all.length - 1]!
  const kept: Array<[string, string]> = []
  for (const hint of all.slice(0, -1)) {
    if (measure([...kept, hint, tail]) > props.width) break
    kept.push(hint)
  }
  return [...kept, tail]
})

const content = computed(() => {
  const chunks = fitted.value.flatMap(([key, label], index) => [
    ...(index > 0 ? [fg(c.line)(SEPARATOR)] : []),
    fg(c.accent)(key),
    fg(c.faint)(` ${label}`),
  ])
  return new StyledText(chunks)
})
</script>

<template>
  <Text :content="content" :height="1" wrapMode="none" :truncate="true" />
</template>
