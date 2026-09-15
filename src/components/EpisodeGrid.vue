<script setup lang="ts">
// Episode picker: a dense grid of `✓ 012` cells that wraps to the terminal
// width and scrolls by whole rows, so the cursor cell is always on screen.
import { computed } from 'vue-termui'
import { Box, StyledText, Text, bg, fg } from 'vue-termui'
import type { TextChunk } from 'vue-termui'
import { c } from '../lib/theme.ts'
import { gridWindow } from '../lib/grid.ts'
import { column, padStart } from '../lib/text.ts'
import type { Episode } from '../types.ts'

const props = defineProps<{
  episodes: Episode[]
  cursor: number
  width: number
  /** How many grid rows fit on screen. */
  rows: number
}>()

const view = computed(() => gridWindow(props.episodes.length, props.cursor, props.width, props.rows))

const lines = computed(() => {
  const { perRow, cellWidth, numWidth, startRow, totalRows } = view.value
  const endRow = Math.min(totalRows, startRow + props.rows)
  const out: { key: string; content: StyledText }[] = []
  for (let row = startRow; row < endRow; row++) {
    const chunks: TextChunk[] = []
    for (let col = 0; col < perRow; col++) {
      const index = row * perRow + col
      const ep = props.episodes[index]
      if (!ep) break
      const number = padStart(String(ep.number || index + 1), numWidth)
      const label = column(`${ep.selected ? '✓' : '□'} ${number}`, cellWidth)
      const here = index === props.cursor
      const chunk = fg(here ? c.text : ep.selected ? c.ok : c.faint)(label)
      chunks.push(here ? bg(c.sel)(chunk) : chunk)
    }
    out.push({ key: `row-${row}`, content: new StyledText(chunks) })
  }
  return out
})
</script>

<template>
  <Box flexDirection="column" :width="width" :height="lines.length">
    <Text
      v-for="line in lines"
      :key="line.key"
      :content="line.content"
      :width="width"
      :height="1"
      wrapMode="none"
      :truncate="true"
    />
  </Box>
</template>
