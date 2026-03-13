<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Bell } from 'lucide-vue-next';
import { useFactcheckStore } from '../../stores/factcheck';

const store = useFactcheckStore();
const clock = ref('');

function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const absM = String(Math.abs(offset) % 60).padStart(2, '0');
  const tz = `GMT${sign}${absH}:${absM}`;
  clock.value = `${h}:${m}:${s} ${tz}`;
}

const alertCount = computed(() => {
  const stats = store.claimStats;
  // Count claims needing attention: evidence conflicts + render failures
  let count = 0;
  for (const claim of store.claimsList) {
    if (claim.evidenceConflict) count++;
    if (claim.renderStatus === 'failed') count++;
  }
  return count;
});

let timer: ReturnType<typeof setInterval>;
onMounted(() => { updateClock(); timer = setInterval(updateClock, 1000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <header class="h-16 bg-card border-b border-border px-6 flex items-center justify-between shrink-0">
    <!-- Left: XALT logo text -->
    <span class="text-xl font-bold tracking-wider text-foreground">XALT</span>

    <!-- Center: Monospace clock + SSE dot -->
    <div class="flex items-center gap-2">
      <span class="font-['Menlo',monospace] text-sm text-muted-foreground">{{ clock }}</span>
      <span class="w-2 h-2 rounded-full" :class="store.sseConnected ? 'bg-success' : 'bg-destructive'" :title="store.sseConnected ? 'Connected' : 'Disconnected'" />
    </div>

    <!-- Right: Bell + Avatar -->
    <div class="flex items-center gap-4">
      <div class="relative">
        <Bell class="w-5 h-5 text-muted-foreground" />
        <span v-if="alertCount > 0" class="absolute -top-1.5 -right-1.5 w-4 h-4 bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full flex items-center justify-center">{{ alertCount > 9 ? '9+' : alertCount }}</span>
      </div>
      <div class="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-bold">FC</div>
    </div>
  </header>
</template>
