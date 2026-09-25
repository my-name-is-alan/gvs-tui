<script setup lang="ts">
import { store } from './store'
import Sidebar from './components/Sidebar.vue'
import TopBar from './components/TopBar.vue'
import Toasts from './components/Toasts.vue'
import QrDialog from './components/QrDialog.vue'
import Setup from './views/Setup.vue'
import Discover from './views/Discover.vue'
import Search from './views/Search.vue'
import Detail from './views/Detail.vue'
import Quality from './views/Quality.vue'
import Downloads from './views/Downloads.vue'
import Settings from './views/Settings.vue'
</script>

<template>
  <div v-if="!store.state" class="boot"><span class="spin" /></div>
  <Setup v-else-if="!store.state.configured" />
  <div v-else class="shell">
    <Sidebar />
    <main class="main">
      <TopBar />
      <div class="body">
        <KeepAlive :include="['DiscoverView']">
          <Discover v-if="store.view === 'discover'" />
          <Search v-else-if="store.view === 'search'" />
          <Detail v-else-if="store.view === 'detail'" />
          <Quality v-else-if="store.view === 'quality'" />
          <Downloads v-else-if="store.view === 'downloads'" />
          <Settings v-else-if="store.view === 'settings'" />
        </KeepAlive>
      </div>
    </main>
  </div>
  <QrDialog v-if="store.qr" />
  <Toasts />
</template>

<style scoped>
.boot { height: 100%; display: flex; align-items: center; justify-content: center; }
.shell { height: 100%; display: flex; }
.main { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; }
.body { flex-grow: 1; min-height: 0; }
</style>
