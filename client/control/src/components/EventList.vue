<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Plus, Search, LayoutGrid, List, Square, ShieldCheck } from 'lucide-vue-next';
import { useFactcheckStore } from '../stores/factcheck';
import type { Run } from '../stores/factcheck';
import EventCard from './EventCard.vue';

const store = useFactcheckStore();
const emit = defineEmits<{ create: [] }>();

const searchQuery = ref('');
const activeFilter = ref<'all' | 'live' | 'completed'>('all');
const viewMode = ref<'grid' | 'list'>('grid');

const liveRuns = computed(() =>
  store.runs.filter(r => store.runningPipelines.has(r.runId))
);

const filteredRuns = computed(() => {
  let list = store.runs;
  if (activeFilter.value === 'live') list = list.filter(r => !r.stoppedAt);
  if (activeFilter.value === 'completed') list = list.filter(r => !!r.stoppedAt);
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(r => (r.youtubeUrl ?? '').toLowerCase().includes(q));
  }
  return list;
});

const filters = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'completed', label: 'Completed' },
] as const;

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

function formatDuration(run: Run): string {
  const start = new Date(run.startedAt).getTime();
  const end = run.stoppedAt ? new Date(run.stoppedAt).getTime() : Date.now();
  const totalSec = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

onMounted(() => { void store.loadRuns(); });
</script>

<template>
  <div class="flex-1 overflow-y-auto p-8">
    <!-- Page header -->
    <div class="flex items-center justify-between mb-1">
      <h2 class="text-xl font-bold text-foreground">Factcheck Events</h2>
      <button
        @click="emit('create')"
        class="bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 rounded-lg text-sm font-medium inline-flex items-center gap-2 transition-colors"
      >
        <Plus class="w-4 h-4" />
        Create
      </button>
    </div>
    <p class="text-sm text-muted-foreground mb-6">All your factcheck events in one place</p>

    <!-- Active pipeline banners -->
    <div v-for="liveRun in liveRuns" :key="liveRun.runId" class="mb-4 bg-success/10 border border-success/30 rounded-lg px-5 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="w-2 h-2 rounded-full bg-success animate-pulse" />
        <span class="text-sm font-medium text-success">Pipeline running</span>
        <span class="text-xs text-success/80 font-mono">{{ liveRun.runId.slice(0, 8) }}</span>
      </div>
      <div class="flex items-center gap-3">
        <button
          @click="store.openRun(liveRun.runId)"
          class="h-8 px-4 rounded-lg text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors"
        >
          Open
        </button>
        <button
          @click="store.stopPipeline(liveRun.runId)"
          class="h-8 px-4 rounded-lg text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors inline-flex items-center gap-1.5"
        >
          <Square class="w-3 h-3" />
          Stop
        </button>
      </div>
    </div>

    <!-- Search bar -->
    <div class="relative mb-4">
      <Search class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <input
        v-model="searchQuery"
        placeholder="Search events..."
        class="w-full bg-background border border-input rounded-lg pl-10 pr-4 py-2.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
      />
    </div>

    <!-- Filters + Sort + View toggle -->
    <div class="flex items-center justify-between mb-6">
      <div class="flex items-center gap-2">
        <button
          v-for="f in filters"
          :key="f.key"
          @click="activeFilter = f.key"
          :class="activeFilter === f.key
            ? 'bg-primary text-primary-foreground'
            : 'bg-secondary text-muted-foreground hover:bg-accent'"
          class="h-8 px-4 rounded-lg text-sm font-medium transition-colors"
        >
          {{ f.label }}
        </button>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm text-muted-foreground">Most Recent &rsaquo;</span>
        <div class="flex items-center gap-1 border border-border rounded-lg p-0.5">
          <button
            @click="viewMode = 'grid'"
            :class="viewMode === 'grid' ? 'bg-secondary text-foreground' : 'text-muted-foreground'"
            class="w-7 h-7 flex items-center justify-center rounded-[7px] transition-colors"
          >
            <LayoutGrid class="w-4 h-4" />
          </button>
          <button
            @click="viewMode = 'list'"
            :class="viewMode === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground'"
            class="w-7 h-7 flex items-center justify-center rounded-[7px] transition-colors"
          >
            <List class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>

    <!-- Grid view -->
    <div v-if="filteredRuns.length && viewMode === 'grid'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <EventCard
        v-for="run in filteredRuns"
        :key="run.runId"
        :run="run"
        @open="store.openRun($event)"
      />
    </div>

    <!-- List view -->
    <table v-else-if="filteredRuns.length && viewMode === 'list'" class="w-full text-sm">
      <thead class="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th class="text-left py-2 px-3">Status</th>
          <th class="text-left py-2 px-3">Title</th>
          <th class="text-left py-2 px-3">Claims</th>
          <th class="text-left py-2 px-3">Started</th>
          <th class="text-left py-2 px-3">Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="run in filteredRuns"
          :key="run.runId"
          @click="store.openRun(run.runId)"
          class="border-b border-border/50 hover:bg-accent cursor-pointer transition-colors"
        >
          <td class="py-2.5 px-3">
            <span v-if="store.runningPipelines.has(run.runId)" class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-success animate-pulse" />
              <span class="text-xs font-medium text-success">Live</span>
            </span>
            <span v-else class="text-xs text-muted-foreground">Completed</span>
          </td>
          <td class="py-2.5 px-3 font-medium text-foreground truncate max-w-[200px]">{{ extractTitle(run.youtubeUrl) }}</td>
          <td class="py-2.5 px-3 text-muted-foreground">{{ run.claimCount }}</td>
          <td class="py-2.5 px-3 text-muted-foreground">{{ formatDate(run.startedAt) }}</td>
          <td class="py-2.5 px-3 text-muted-foreground">{{ formatDuration(run) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- Empty state: no events at all -->
    <div v-else-if="store.runs.length === 0" class="flex flex-col items-center justify-center h-64 text-center">
      <div class="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
        <ShieldCheck class="w-8 h-8 text-muted-foreground" />
      </div>
      <p class="text-lg font-medium text-foreground mb-1">No factcheck events yet</p>
      <p class="text-sm text-muted-foreground mb-4">Create your first event to begin monitoring a live stream.</p>
      <button @click="emit('create')" class="bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-5 rounded-lg text-sm font-medium transition-colors">
        Create Event
      </button>
    </div>

    <!-- Empty state: no search results -->
    <div v-else class="flex flex-col items-center justify-center h-64 text-center">
      <div class="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
        <Search class="w-6 h-6 text-muted-foreground" />
      </div>
      <p class="text-lg font-medium text-foreground mb-1">No matching events</p>
      <p class="text-sm text-muted-foreground">Try adjusting your search or filters.</p>
    </div>
  </div>
</template>
