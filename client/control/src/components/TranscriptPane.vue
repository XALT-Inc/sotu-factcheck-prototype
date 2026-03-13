<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import { ArrowDownToLine, Pause, Loader2, FileAudio } from 'lucide-vue-next';

const store = useFactcheckStore();

const container = ref<HTMLElement>();
const autoScroll = ref(true);

// Auto-scroll when new segments arrive
watch(() => store.transcriptSegments.length, () => {
  if (autoScroll.value && container.value) {
    nextTick(() => {
      container.value!.scrollTop = container.value!.scrollHeight;
    });
  }
});

// Check if a segment is near a detected claim
function isClaimSegment(seg: { text: string; at: string }): boolean {
  const segTime = new Date(seg.at).getTime() / 1000;
  return store.claimsList.some(claim => {
    const claimTime = claim.chunkStartSec;
    return Math.abs(segTime - claimTime) < 5;
  });
}

const isLive = computed(() => store.isViewingLiveRun);
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="px-4 py-3 border-b border-border flex items-center justify-between">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-bold text-muted-foreground uppercase tracking-wider">Live Transcript</h3>
        <span class="w-1.5 h-1.5 rounded-full" :class="store.sseConnected ? 'bg-success' : 'bg-destructive'" />
      </div>
      <button
        @click="autoScroll = !autoScroll"
        class="w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-accent"
        :title="autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'"
      >
        <ArrowDownToLine v-if="autoScroll" class="w-3.5 h-3.5 text-success" />
        <Pause v-else class="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
    <div ref="container" class="flex-1 overflow-y-auto p-4 space-y-2">
      <!-- Empty: pipeline running, no segments -->
      <div v-if="store.transcriptSegments.length === 0 && isLive" class="flex flex-col items-center justify-center h-full text-center">
        <Loader2 class="w-5 h-5 animate-spin text-primary mb-2" />
        <p class="text-sm text-muted-foreground">Listening for audio...</p>
      </div>

      <!-- Empty: pipeline not running -->
      <div v-else-if="store.transcriptSegments.length === 0" class="flex flex-col items-center justify-center h-full text-center">
        <FileAudio class="w-5 h-5 text-muted-foreground mb-2" />
        <p class="text-sm text-muted-foreground">Pipeline is not active</p>
      </div>

      <!-- Transcript segments -->
      <div
        v-for="(seg, i) in store.transcriptSegments"
        :key="i"
        :class="isClaimSegment(seg) ? 'border-l-2 border-primary pl-2' : 'pl-3'"
        class="text-sm leading-relaxed transition-colors"
      >
        <span v-if="isClaimSegment(seg)" class="text-xs bg-primary/15 text-primary px-1.5 rounded mb-0.5 inline-block">
          Claim detected
        </span>
        <div>
          <span class="text-xs text-muted-foreground/50 font-mono mr-2" :title="new Date(seg.at).toLocaleString()">{{ new Date(seg.at).toLocaleTimeString() }}</span>
          <span class="text-foreground">{{ seg.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
