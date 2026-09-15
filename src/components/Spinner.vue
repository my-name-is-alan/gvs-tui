<script setup lang="ts">
// Braille spinner shown while a gateway call is in flight.
import { ref } from 'vue-termui'
import { StyledText, Text, fg, useInterval } from 'vue-termui'
import { c } from '../lib/theme.ts'

const props = withDefaults(defineProps<{ label?: string }>(), { label: '' })

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const frame = ref(0)
useInterval(() => {
  frame.value = (frame.value + 1) % FRAMES.length
}, 80)

const content = () =>
  new StyledText([fg(c.accent)(FRAMES[frame.value] ?? '⠋'), fg(c.dim)(props.label ? ` ${props.label}` : '')])
</script>

<template>
  <Text :content="content()" :height="1" wrapMode="none" />
</template>
