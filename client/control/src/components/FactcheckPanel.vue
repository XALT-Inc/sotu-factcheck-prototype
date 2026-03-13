<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import { ArrowLeft, Loader2, BarChart3, PanelRightClose, PanelRight } from 'lucide-vue-next';
import PipelineControl from './PipelineControl.vue';
import ClaimList from './ClaimList.vue';
import ClaimDetail from './ClaimDetail.vue';
import TranscriptPane from './TranscriptPane.vue';

const store = useFactcheckStore();
const showTranscript = ref(true);

function extractTitle(url: string | null): string {
  if (!url) return 'Untitled Event';
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return v ? `youtube/${v}` : u.pathname.slice(1) || url;
  } catch {
    return url;
  }
}

const isLive = computed(() => store.isViewingLiveRun);

function formatDuration(startedAt: string, stoppedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = stoppedAt ? new Date(stoppedAt).getTime() : Date.now();
  const totalSec = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const recentTranscript = computed(() => {
  const segs = store.transcriptSegments;
  return segs.slice(-5);
});

// Keyboard navigation
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (store.selectedClaimId) {
      store.selectClaim(null);
      e.preventDefault();
    }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const list = store.claimsList;
    if (list.length === 0) return;
    const currentIdx = store.selectedClaimId
      ? list.findIndex(c => c.claimId === store.selectedClaimId)
      : -1;
    let nextIdx: number;
    if (e.key === 'ArrowDown') {
      nextIdx = currentIdx < list.length - 1 ? currentIdx + 1 : 0;
    } else {
      nextIdx = currentIdx > 0 ? currentIdx - 1 : list.length - 1;
    }
    store.selectClaim(list[nextIdx].claimId);
    e.preventDefault();
  }
}

onMounted(() => { document.addEventListener('keydown', handleKeydown); });
onUnmounted(() => { document.removeEventListener('keydown', handleKeydown); });
</script>

<template>
  <div class="flex flex-col flex-1 overflow-hidden">
    <!-- Panel header -->
    <div class="bg-card border-b border-border px-4 py-2 flex items-center gap-3 shrink-0">
      <button
        @click="store.closePanel()"
        class="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft class="w-4 h-4" />
        Back
      </button>
      <span class="text-sm font-medium text-foreground truncate">{{ extractTitle(store.viewingRun?.youtubeUrl ?? null) }}</span>
      <span class="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full font-semibold">BETA</span>
      <span
        class="flex items-center gap-1 text-xs"
        :class="isLive ? 'text-success' : 'text-muted-foreground'"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="isLive ? 'bg-success animate-pulse' : 'bg-muted-foreground'"
        />
        {{ isLive ? 'Live' : 'Completed' }}
      </span>
      <span class="text-xs text-muted-foreground">{{ store.claimsList.length }} claims</span>

      <!-- Spacer -->
      <div class="flex-1" />

      <!-- Transcript toggle -->
      <button
        @click="showTranscript = !showTranscript"
        class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
        :title="showTranscript ? 'Hide transcript' : 'Show transcript'"
      >
        <PanelRightClose v-if="showTranscript" class="w-4 h-4" />
        <PanelRight v-else class="w-4 h-4" />
      </button>
    </div>

    <!-- Three-column layout -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Left panel: pipeline control + claims list -->
      <div class="w-96 border-r border-border flex flex-col overflow-hidden shrink-0">
        <PipelineControl />
        <ClaimList />
      </div>

      <!-- Center: Claim detail -->
      <div class="flex-1 overflow-y-auto">
        <Transition name="fade" mode="out-in">
          <ClaimDetail v-if="store.selectedClaim" :key="store.selectedClaimId ?? undefined" />

          <!-- Empty state: pipeline running, no claim selected -->
          <div v-else-if="isLive" key="live-empty" class="flex flex-col items-center justify-center h-full text-center px-8">
            <Loader2 class="w-8 h-8 text-primary animate-spin mb-4" />
            <p class="text-lg font-medium text-foreground mb-1">Listening for claims...</p>
            <p class="text-sm text-muted-foreground mb-6">Claims will appear as they are detected in the live stream.</p>

            <!-- Recent transcript preview -->
            <div v-if="recentTranscript.length > 0" class="w-full max-w-md bg-card border border-border rounded-lg overflow-hidden">
              <div class="px-3 py-2 border-b border-border text-xs text-muted-foreground font-medium">Recent transcript</div>
              <div class="p-3 space-y-1.5">
                <div v-for="(seg, i) in recentTranscript" :key="i" class="text-xs">
                  <span class="text-muted-foreground/50 font-mono mr-2">{{ new Date(seg.at).toLocaleTimeString() }}</span>
                  <span class="text-muted-foreground">{{ seg.text }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Empty state: completed run, no claim selected -->
          <div v-else-if="store.viewingRun" key="completed-empty" class="flex flex-col items-center justify-center h-full text-center px-8">
            <BarChart3 class="w-8 h-8 text-muted-foreground mb-4" />
            <p class="text-lg font-medium text-foreground mb-1">Run Summary</p>
            <div class="text-sm text-muted-foreground space-y-1">
              <p><span class="text-foreground font-medium">{{ store.claimStats.total }}</span> claims detected</p>
              <p>
                <span class="text-success font-medium">{{ store.claimStats.approved }}</span> approved
                <span class="mx-1">&middot;</span>
                <span class="text-destructive font-medium">{{ store.claimStats.rejected }}</span> rejected
                <span class="mx-1">&middot;</span>
                <span class="font-medium">{{ store.claimStats.pending }}</span> pending
              </p>
              <p><span class="text-primary font-medium">{{ store.claimStats.rendered }}</span> rendered</p>
              <p>Duration: {{ formatDuration(store.viewingRun.startedAt, store.viewingRun.stoppedAt) }}</p>
            </div>
          </div>

          <!-- Fallback empty state -->
          <div v-else key="fallback-empty" class="flex items-center justify-center h-full text-muted-foreground">
            Select a claim to view details
          </div>
        </Transition>
      </div>

      <!-- Right: Transcript -->
      <Transition name="slide-right">
        <div v-if="showTranscript" class="w-80 border-l border-border shrink-0">
          <TranscriptPane />
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.2s ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
