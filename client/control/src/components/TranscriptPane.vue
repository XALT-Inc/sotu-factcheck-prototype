<script setup lang="ts">
import { useFactcheckStore } from '../stores/factcheck';

const store = useFactcheckStore();
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="px-4 py-3 border-b border-slate-800">
      <h3 class="text-sm font-bold text-slate-400 uppercase tracking-wider">Live Transcript</h3>
    </div>
    <div class="flex-1 overflow-y-auto p-4 space-y-2">
      <div v-if="store.transcriptSegments.length === 0" class="text-sm text-slate-600">
        Transcript will appear here when pipeline is running...
      </div>
      <div v-for="(seg, i) in store.transcriptSegments" :key="i" class="text-sm text-slate-400 leading-relaxed">
        <span class="text-xs text-slate-600 font-mono mr-2">{{ new Date(seg.at).toLocaleTimeString() }}</span>
        {{ seg.text }}
      </div>
    </div>
  </div>
</template>
