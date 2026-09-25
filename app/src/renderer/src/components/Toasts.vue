<script setup lang="ts">
import { store } from '../store'
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.tone">{{ t.message }}</div>
  </div>
</template>

<style scoped>
.toasts { position: fixed; right: 24px; bottom: 24px; display: flex; flex-direction: column; gap: 10px; z-index: 50; max-width: 420px; }
.toast {
  padding: 12px 16px; border-radius: 8px; background: var(--ink); color: var(--paper); font-size: 14px; line-height: 1.5;
  box-shadow: var(--shadow-orange); word-break: break-word;
}
.toast.ok { box-shadow: 4px 4px 0 var(--ok); }
.toast.err { background: var(--err); color: #fff; box-shadow: var(--shadow-ink); }
.toast.warn { background: var(--orange-soft); color: var(--orange-text); border: 1.5px solid var(--orange-text); box-shadow: none; }
</style>
