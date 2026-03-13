<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Run } from '../stores/factcheck';
import { useFactcheckStore } from '../stores/factcheck';

const props = defineProps<{ run: Run }>();
const emit = defineEmits<{ open: [runId: string] }>();
const store = useFactcheckStore();

const imgFailed = ref(false);

const isCurrentLive = computed(() =>
  !props.run.stoppedAt && store.runningPipelines.has(props.run.runId)
);

function extractVideoIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      return u.searchParams.get('v') || null;
    }
  } catch { /* ignore */ }
  return null;
}

const thumbnailUrl = computed(() => {
  const videoId = extractVideoIdFromUrl(props.run.youtubeUrl);
  if (!videoId || imgFailed.value) return null;
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
});

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const elapsed = computed(() => {
  const start = new Date(props.run.startedAt).getTime();
  const end = props.run.stoppedAt ? new Date(props.run.stoppedAt).getTime() : Date.now();
  const totalSec = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
});
</script>

<template>
  <div
    @click="emit('open', props.run.runId)"
    class="bg-card border border-border rounded-lg overflow-hidden hover:border-primary transition-colors cursor-pointer group"
  >
    <!-- Preview area -->
    <div class="relative h-40 flex flex-col items-center justify-center">
      <!-- YouTube thumbnail -->
      <img
        v-if="thumbnailUrl"
        :src="thumbnailUrl"
        @error="imgFailed = true"
        class="absolute inset-0 w-full h-full object-cover"
        alt=""
      />
      <!-- Fallback gradient -->
      <div
        v-else
        class="absolute inset-0"
        :class="isCurrentLive
          ? 'bg-gradient-to-br from-emerald-400/20 to-emerald-600/10'
          : 'bg-gradient-to-br from-secondary to-muted'"
      />
      <!-- Status indicator -->
      <div v-if="isCurrentLive" class="absolute top-3 left-3 flex items-center gap-1.5 bg-white/90 backdrop-blur-sm rounded-full px-2.5 py-1">
        <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span class="text-xs font-medium text-emerald-700">Live</span>
      </div>

      <!-- Content overlay -->
      <div class="relative z-10 text-center px-4" :class="thumbnailUrl ? 'bg-black/40 rounded-lg px-3 py-2' : ''">
        <p class="text-sm font-medium" :class="thumbnailUrl ? 'text-white' : 'text-foreground/80'">
          {{ run.claimCount }} claim{{ run.claimCount === 1 ? '' : 's' }}
        </p>
        <p class="text-xs mt-0.5" :class="thumbnailUrl ? 'text-white/80' : 'text-muted-foreground'">
          <template v-if="isCurrentLive">{{ elapsed }} running</template>
          <template v-else>{{ elapsed }}<span v-if="run.stopReason"> &middot; {{ run.stopReason }}</span></template>
        </p>
      </div>

      <!-- Claim count badge -->
      <div class="absolute bottom-3 right-3 bg-white/90 backdrop-blur-sm rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground">
        {{ run.claimCount }} claim{{ run.claimCount === 1 ? '' : 's' }}
      </div>
    </div>

    <!-- Card footer -->
    <div class="p-4">
      <p class="text-sm font-medium text-foreground truncate">{{ extractTitle(run.youtubeUrl) }}</p>
      <p class="text-xs text-muted-foreground mt-1">{{ formatDate(run.startedAt) }}</p>
    </div>
  </div>
</template>
