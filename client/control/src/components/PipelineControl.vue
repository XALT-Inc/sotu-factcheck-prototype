<script setup lang="ts">
import { ref } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';

const store = useFactcheckStore();
const youtubeUrl = ref('');
const speechContext = ref('');
const operatorNotes = ref('');
const error = ref('');

async function start() {
  error.value = '';
  if (!youtubeUrl.value.trim()) { error.value = 'YouTube URL is required'; return; }
  const res = await store.startPipeline(youtubeUrl.value.trim(), {
    speechContext: speechContext.value.trim() || undefined,
    operatorNotes: operatorNotes.value.trim() || undefined,
  });
  if (!res.ok) error.value = (res.error as string) ?? 'Failed to start';
}

async function stop() {
  await store.stopPipeline();
}
</script>

<template>
  <div class="p-4 border-b border-slate-800 space-y-3">
    <div v-if="!store.running">
      <input v-model="youtubeUrl" placeholder="YouTube URL" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
      <details class="mt-2">
        <summary class="text-xs text-slate-500 cursor-pointer">Advanced options</summary>
        <div class="mt-2 space-y-2">
          <textarea v-model="speechContext" placeholder="Speech context" rows="2" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500 resize-none" />
          <textarea v-model="operatorNotes" placeholder="Operator notes" rows="2" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500 resize-none" />
        </div>
      </details>
      <button @click="start" class="mt-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded py-2 text-sm font-medium">Start Pipeline</button>
    </div>
    <div v-else>
      <div class="text-sm text-slate-400 mb-2">Run: <span class="font-mono text-xs text-slate-500">{{ store.runId?.slice(0, 8) }}</span></div>
      <button @click="stop" class="w-full bg-red-600 hover:bg-red-700 text-white rounded py-2 text-sm font-medium">Stop Pipeline</button>
    </div>
    <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>
  </div>
</template>
