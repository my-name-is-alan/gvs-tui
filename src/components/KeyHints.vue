<script setup lang="ts">
// Footer key hints: `⏎ 确认  ·  esc 返回` with the keys in the accent color.
// When the terminal is narrow the low-priority hints are dropped rather than
// letting the line wrap; the trailing hint is always kept. `extra` (the global
// F-keys) is right-aligned and only shown when it fits after the scene hints.
import { computed } from 'vue-termui'
import { StyledText, Text, fg } from 'vue-termui'
import { c } from '../lib/theme.ts'
import { displayWidth } from '../lib/text.ts'

const props = defineProps<{ hints: Array<[string, string]>; width: number; extra?: Array<[string, string]> }>()

const SEPARATOR = '  ·  '
const SEPARATOR_CELLS = 5
const EXTRA_GAP = '  '

function measure(hints: Array<[string, string]>, gap = SEPARATOR_CELLS): number {
  if (!hints.length) return 0
  const body = hints.reduce((n, [key, label]) => n + displayWidth(key) + 1 + displayWidth(label), 0)
  return body + (hints.length - 1) * gap
}

const fitted = computed(() => {
  const all = props.hints
  if (measure(all) <= props.width || all.length <= 2) return all
  const head = all[0]!
  const tail = all[all.length - 1]!
  if (measure([head, tail]) > props.width)
    return measure([head]) <= props.width ? [head] : [tail]
  const kept: Array<[string, string]> = [head]
  for (const hint of all.slice(1, -1)) {
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
  const extra = props.extra ?? []
  const room = props.width - measure(fitted.value) - measure(extra, EXTRA_GAP.length)
  if (extra.length && room >= 4) {
    chunks.push({ __isChunk: true, text: ' '.repeat(room) })
    extra.forEach(([key, label], index) => {
      if (index > 0) chunks.push({ __isChunk: true, text: EXTRA_GAP })
      chunks.push(fg(c.dim)(key), fg(c.faint)(` ${label}`))
    })
  }
  return new StyledText(chunks)
})
</script>

<template>
  <Text :content="content" :height="1" wrapMode="none" :truncate="true" />
</template>
