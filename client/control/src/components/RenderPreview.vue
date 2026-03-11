<script setup lang="ts">
import { useFactcheckStore } from '../stores/factcheck';
import type { Claim } from '../stores/factcheck';

const store = useFactcheckStore();
defineProps<{ claim: Claim }>();

function exportUrl(claimId: string): string {
  const pw = localStorage.getItem('controlPassword');
  const base = `/api/claims/${encodeURIComponent(claimId)}/export-image`;
  return pw ? `${base}?control_password=${encodeURIComponent(pw)}` : base;
}

async function rerender(claimId: string, version: number) {
  await store.triggerRender(claimId, version, true);
}
</script>

<template>
  <div v-if="claim.renderStatus !== 'none'" class="space-y-3">
    <div class="flex items-center gap-3">
      <h3 class="text-sm font-bold text-slate-400 uppercase tracking-wider">Render</h3>
      <span :class="{
        'text-green-400': claim.renderStatus === 'ready',
        'text-amber-400': claim.renderStatus === 'queued' || claim.renderStatus === 'rendering',
        'text-red-400': claim.renderStatus === 'failed',
      }" class="text-xs font-medium">{{ claim.renderStatus }}</span>
    </div>

    <div v-if="claim.renderStatus === 'ready' && claim.artifactUrl" class="space-y-2">
      <img :src="claim.artifactUrl" alt="Rendered fact-check graphic" class="w-full rounded-lg border border-slate-800" />
      <div class="flex gap-2">
        <a :href="exportUrl(claim.claimId)" target="_blank" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300">Download PNG</a>
        <button @click="rerender(claim.claimId, claim.version)" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300">Re-render</button>
      </div>
    </div>

    <p v-if="claim.renderStatus === 'failed' && claim.renderError" class="text-xs text-red-400">{{ claim.renderError }}</p>
  </div>
</template>
