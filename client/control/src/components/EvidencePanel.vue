<script setup lang="ts">
import { ref } from 'vue';
import type { Claim } from '../stores/factcheck';

const props = defineProps<{ claim: Claim }>();
const activeTab = ref<'google' | 'fred' | 'congress'>('google');

function formatNumber(val: unknown): string {
  if (typeof val === 'number') return val.toLocaleString();
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? val : n.toLocaleString();
  }
  return String(val ?? '');
}

function stateClass(state: string): string {
  if (state === 'matched') return 'bg-success/15 text-success';
  if (state === 'error') return 'bg-destructive/15 text-destructive';
  if (state === 'searching' || state === 'pending') return 'bg-info/15 text-info';
  return 'bg-secondary text-muted-foreground';
}
</script>

<template>
  <div class="bg-card rounded-lg overflow-hidden border border-border">
    <div class="flex border-b border-border text-xs">
      <button @click="activeTab = 'google'" :class="activeTab === 'google' ? 'text-primary border-b-2 border-primary bg-secondary' : 'text-muted-foreground hover:text-foreground'" class="px-4 py-2 transition-colors">
        Google FC ({{ claim.sources?.length ?? 0 }})
      </button>
      <button @click="activeTab = 'fred'" :class="activeTab === 'fred' ? 'text-primary border-b-2 border-primary bg-secondary' : 'text-muted-foreground hover:text-foreground'" class="px-4 py-2 transition-colors">
        FRED
        <span class="ml-1" :class="claim.fredEvidenceState === 'matched' ? 'text-green-600' : 'text-muted-foreground/50'">&bull;</span>
      </button>
      <button @click="activeTab = 'congress'" :class="activeTab === 'congress' ? 'text-primary border-b-2 border-primary bg-secondary' : 'text-muted-foreground hover:text-foreground'" class="px-4 py-2 transition-colors">
        Congress
        <span class="ml-1" :class="claim.congressEvidenceState === 'matched' ? 'text-green-600' : 'text-muted-foreground/50'">&bull;</span>
      </button>
    </div>

    <div class="p-4">
      <!-- Google FC -->
      <div v-if="activeTab === 'google'">
        <div class="flex items-center gap-2 mb-3">
          <span :class="stateClass(claim.googleEvidenceState)" class="px-2 py-0.5 rounded-full text-xs font-medium">
            {{ claim.googleEvidenceState }}
          </span>
          <span v-if="claim.googleFcVerdict" class="text-xs text-muted-foreground">
            Verdict: <span class="font-medium text-foreground">{{ claim.googleFcVerdict }}</span>
          </span>
          <span v-if="claim.googleFcConfidence != null" class="text-xs text-muted-foreground">
            ({{ Math.round(claim.googleFcConfidence * 100) }}%)
          </span>
        </div>
        <p v-if="claim.googleFcSummary" class="text-sm text-muted-foreground mb-3">{{ claim.googleFcSummary }}</p>
        <div v-if="claim.sources && claim.sources.length > 0" class="space-y-2">
          <div v-for="(source, i) in claim.sources" :key="i" class="bg-secondary p-3 rounded-lg text-sm">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-card-foreground">{{ source.publisher }}</span>
              <span class="text-xs text-muted-foreground">{{ source.textualRating }}</span>
            </div>
            <p v-if="source.claimReviewed" class="text-xs text-muted-foreground line-clamp-2">{{ source.claimReviewed }}</p>
            <a v-if="source.url" :href="source.url" target="_blank" rel="noopener" class="text-xs text-primary hover:underline mt-1 block transition-colors">{{ source.url }}</a>
          </div>
        </div>
        <p v-else class="text-sm text-muted-foreground">No Google Fact Check sources</p>
      </div>

      <!-- FRED -->
      <div v-if="activeTab === 'fred'">
        <div class="mb-3">
          <span :class="stateClass(claim.fredEvidenceState)" class="px-2 py-0.5 rounded-full text-xs font-medium">
            {{ claim.fredEvidenceState }}
          </span>
        </div>
        <p v-if="claim.fredEvidenceSummary" class="text-sm text-muted-foreground">{{ claim.fredEvidenceSummary }}</p>
        <div v-if="claim.fredEvidenceSources && (claim.fredEvidenceSources as unknown[]).length > 0" class="mt-2 space-y-1">
          <div v-for="(source, i) in (claim.fredEvidenceSources as Array<Record<string, unknown>>)" :key="i" class="text-xs text-muted-foreground">
            {{ source.seriesTitle ?? source.seriesId }}: <span class="font-mono text-foreground">{{ formatNumber(source.value) }}</span> ({{ source.observationDate }})
          </div>
        </div>
      </div>

      <!-- Congress -->
      <div v-if="activeTab === 'congress'">
        <div class="mb-3">
          <span :class="stateClass(claim.congressEvidenceState)" class="px-2 py-0.5 rounded-full text-xs font-medium">
            {{ claim.congressEvidenceState }}
          </span>
        </div>
        <p v-if="claim.congressEvidenceSummary" class="text-sm text-muted-foreground">{{ claim.congressEvidenceSummary }}</p>
        <div v-if="claim.congressEvidenceSources && (claim.congressEvidenceSources as unknown[]).length > 0" class="mt-2 space-y-1">
          <div v-for="(source, i) in (claim.congressEvidenceSources as Array<Record<string, unknown>>)" :key="i" class="text-xs text-muted-foreground">
            <a v-if="source.url" :href="source.url as string" target="_blank" rel="noopener" class="text-primary hover:underline">{{ source.title }}</a>
            <span v-else>{{ source.title }}</span>
            <span v-if="source.latestAction"> — {{ source.latestAction }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
