<script setup lang="ts">
import { useFactcheckStore } from '../stores/factcheck';
import type { Claim } from '../stores/factcheck';
import { Loader2 } from 'lucide-vue-next';

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
      <h3 class="text-sm font-bold text-muted-foreground uppercase tracking-wider">Render</h3>
      <span v-if="claim.renderStatus === 'queued' || claim.renderStatus === 'rendering'" class="flex items-center gap-1.5 text-xs font-medium text-warning">
        <Loader2 class="w-3 h-3 animate-spin" />
        {{ claim.renderStatus }}
      </span>
      <span v-else :class="{
        'text-success': claim.renderStatus === 'ready',
        'text-destructive': claim.renderStatus === 'failed',
      }" class="text-xs font-medium">{{ claim.renderStatus }}</span>
    </div>

    <div v-if="claim.renderStatus === 'ready' && claim.artifactUrl" class="space-y-2">
      <img :src="claim.artifactUrl" alt="Rendered fact-check graphic" class="w-full rounded-lg border border-border" />
      <div class="flex gap-2">
        <a :href="exportUrl(claim.claimId)" target="_blank" class="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-xs font-medium transition-colors">Download PNG</a>
        <button @click="rerender(claim.claimId, claim.version)" class="px-4 py-2 bg-secondary hover:bg-accent rounded-lg text-xs text-secondary-foreground border border-border transition-colors">Re-render</button>
      </div>
    </div>

    <p v-if="claim.renderStatus === 'failed' && claim.renderError" class="text-xs text-destructive">{{ claim.renderError }}</p>
  </div>
</template>
