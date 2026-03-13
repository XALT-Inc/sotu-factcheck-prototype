<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import { Square, Activity, Check, AlertTriangle } from 'lucide-vue-next';

const store = useFactcheckStore();

// Elapsed timer
const elapsed = ref('');
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function updateElapsed() {
  const run = store.viewingRun;
  if (!run) { elapsed.value = ''; return; }
  const start = new Date(run.startedAt).getTime();
  const end = run.stoppedAt ? new Date(run.stoppedAt).getTime() : Date.now();
  elapsed.value = formatElapsed(end - start);
}

onMounted(() => {
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
});
onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
});

const isLive = computed(() => store.isViewingLiveRun);

const health = computed(() => store.healthData as Record<string, unknown>);

const ingestLabel = computed(() => {
  const state = health.value.ingestState as string | undefined;
  if (state === 'listening') return { text: 'Listening', color: 'bg-success' };
  if (state === 'reconnecting') return { text: `Reconnecting`, color: 'bg-warning' };
  if (state === 'stalled') return { text: 'Stalled', color: 'bg-destructive' };
  return isLive.value ? { text: 'Active', color: 'bg-success' } : { text: 'Inactive', color: 'bg-muted-foreground' };
});

function extractVideoId(url: string | null): string {
  if (!url) return 'Unknown';
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return v ? `youtube/${v}` : u.pathname.slice(1) || url;
  } catch {
    return url;
  }
}

// Compact services summary
const serviceKeys = ['hasGeminiKey', 'hasGoogleFactCheckKey', 'hasFredKey', 'hasCongressKey', 'hasTakumiRenderer'] as const;
const serviceNames: Record<string, string> = { hasGeminiKey: 'Gemini', hasGoogleFactCheckKey: 'Google FC', hasFredKey: 'FRED', hasCongressKey: 'Congress', hasTakumiRenderer: 'Render' };

const activeServiceCount = computed(() => serviceKeys.filter(k => Boolean(health.value[k])).length);
const totalServiceCount = serviceKeys.length;
const allServicesUp = computed(() => activeServiceCount.value === totalServiceCount);
const missingServices = computed(() => serviceKeys.filter(k => !health.value[k]).map(k => serviceNames[k]));

async function stop() {
  if (!window.confirm('Stop the running pipeline?')) return;
  await store.stopPipeline(store.viewingRunId ?? undefined);
}
</script>

<template>
  <div class="border-b border-border">
    <!-- Live run status -->
    <div v-if="isLive" class="p-4 space-y-2">
      <!-- Video ID + Run info -->
      <div>
        <div class="flex items-center gap-2">
          <Activity class="w-4 h-4 text-success" />
          <span class="text-sm font-semibold text-foreground truncate">{{ extractVideoId(store.viewingRun?.youtubeUrl ?? null) }}</span>
        </div>
        <div class="text-xs text-muted-foreground mt-0.5">
          Run: <span class="font-mono">{{ store.viewingRunId?.slice(0, 8) }}</span>
          <span class="mx-1">&middot;</span>
          {{ elapsed }} elapsed
        </div>
      </div>

      <!-- Status dots -->
      <div class="flex items-center gap-4 text-xs">
        <span class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full" :class="ingestLabel.color" />
          <span class="text-muted-foreground">{{ ingestLabel.text }}</span>
        </span>
        <span class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full" :class="store.sseConnected ? 'bg-success' : 'bg-destructive'" />
          <span class="text-muted-foreground">SSE {{ store.sseConnected ? 'Connected' : 'Disconnected' }}</span>
        </span>
      </div>

      <!-- Services — compact summary -->
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <component :is="allServicesUp ? Check : AlertTriangle" class="w-3 h-3" :class="allServicesUp ? 'text-success' : 'text-warning'" />
        <span>{{ activeServiceCount }}/{{ totalServiceCount }} services</span>
        <span v-if="!allServicesUp" class="text-warning">
          — missing {{ missingServices.join(', ') }}
        </span>
      </div>

      <!-- Claim stats -->
      <div class="text-xs text-muted-foreground leading-relaxed">
        <span class="text-foreground font-medium">{{ store.claimStats.total }}</span> detected
        <template v-if="store.claimStats.researching > 0">
          <span class="mx-0.5">&middot;</span>
          <span class="text-info font-medium">{{ store.claimStats.researching }}</span> researching
        </template>
        <template v-if="store.claimStats.pending > 0">
          <span class="mx-0.5">&middot;</span>
          <span class="text-warning font-medium">{{ store.claimStats.pending }}</span> pending
        </template>
        <template v-if="store.claimStats.approved > 0">
          <span class="mx-0.5">&middot;</span>
          <span class="text-success font-medium">{{ store.claimStats.approved }}</span> approved
        </template>
        <template v-if="store.claimStats.rendered > 0">
          <span class="mx-0.5">&middot;</span>
          <span class="text-primary font-medium">{{ store.claimStats.rendered }}</span> rendered
        </template>
      </div>

      <!-- Stop button -->
      <div class="mt-4">
        <button @click="stop" class="w-full bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors">
          <Square class="w-3.5 h-3.5" />
          Stop Pipeline
        </button>
      </div>
    </div>

    <!-- Completed run summary -->
    <div v-else-if="store.viewingRun" class="p-4 space-y-2">
      <div class="text-sm font-semibold text-foreground truncate">{{ extractVideoId(store.viewingRun.youtubeUrl) }}</div>
      <div class="text-xs text-muted-foreground">
        Completed <span class="mx-0.5">&middot;</span> Ran {{ elapsed }}
      </div>
      <div v-if="store.viewingRun.stopReason" class="text-xs text-muted-foreground">
        Stopped: {{ store.viewingRun.stopReason }}
      </div>
      <div class="text-xs text-muted-foreground">
        <span class="text-foreground font-medium">{{ store.claimStats.total }}</span> claims
        <template v-if="store.claimStats.approved > 0">
          <span class="mx-0.5">&middot;</span>
          <span class="text-success font-medium">{{ store.claimStats.approved }}</span> approved
        </template>
        <template v-if="store.claimStats.rendered > 0">
          <span class="mx-0.5">&middot;</span>
          <span class="text-primary font-medium">{{ store.claimStats.rendered }}</span> rendered
        </template>
      </div>
    </div>
  </div>
</template>
