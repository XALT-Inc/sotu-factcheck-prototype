<script setup lang="ts">
import { ref } from 'vue';
import type { Claim } from '../stores/factcheck';

defineProps<{ claim: Claim }>();
const activeTab = ref<'google' | 'fred' | 'congress'>('google');
</script>

<template>
  <div class="bg-slate-900 rounded-lg overflow-hidden">
    <div class="flex border-b border-slate-800 text-xs">
      <button @click="activeTab = 'google'" :class="activeTab === 'google' ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50' : 'text-slate-500'" class="px-4 py-2">
        Google FC
        <span class="ml-1" :class="claim.googleEvidenceState === 'matched' ? 'text-green-400' : 'text-slate-600'">&bull;</span>
      </button>
      <button @click="activeTab = 'fred'" :class="activeTab === 'fred' ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50' : 'text-slate-500'" class="px-4 py-2">
        FRED
        <span class="ml-1" :class="claim.fredEvidenceState === 'matched' ? 'text-green-400' : 'text-slate-600'">&bull;</span>
      </button>
      <button @click="activeTab = 'congress'" :class="activeTab === 'congress' ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50' : 'text-slate-500'" class="px-4 py-2">
        Congress
        <span class="ml-1" :class="claim.congressEvidenceState === 'matched' ? 'text-green-400' : 'text-slate-600'">&bull;</span>
      </button>
    </div>

    <div class="p-4">
      <!-- Google FC -->
      <div v-if="activeTab === 'google'">
        <div class="text-xs text-slate-500 mb-2">State: {{ claim.googleEvidenceState }}</div>
        <div v-if="claim.sources && claim.sources.length > 0" class="space-y-2">
          <div v-for="(source, i) in claim.sources" :key="i" class="bg-slate-800/50 p-3 rounded text-sm">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-slate-300">{{ source.publisher }}</span>
              <span class="text-xs text-slate-500">{{ source.textualRating }}</span>
            </div>
            <p v-if="source.claimReviewed" class="text-xs text-slate-400 line-clamp-2">{{ source.claimReviewed }}</p>
            <a v-if="source.url" :href="source.url" target="_blank" rel="noopener" class="text-xs text-blue-400 hover:underline mt-1 block">{{ source.url }}</a>
          </div>
        </div>
        <p v-else class="text-sm text-slate-600">No Google Fact Check sources</p>
      </div>

      <!-- FRED -->
      <div v-if="activeTab === 'fred'">
        <div class="text-xs text-slate-500 mb-2">State: {{ claim.fredEvidenceState }}</div>
        <p v-if="claim.fredEvidenceSummary" class="text-sm text-slate-400">{{ claim.fredEvidenceSummary }}</p>
        <div v-if="claim.fredEvidenceSources && (claim.fredEvidenceSources as unknown[]).length > 0" class="mt-2 space-y-1">
          <div v-for="(source, i) in (claim.fredEvidenceSources as Array<Record<string, unknown>>)" :key="i" class="text-xs text-slate-500">
            {{ source.seriesTitle ?? source.seriesId }}: {{ source.value }} ({{ source.observationDate }})
          </div>
        </div>
      </div>

      <!-- Congress -->
      <div v-if="activeTab === 'congress'">
        <div class="text-xs text-slate-500 mb-2">State: {{ claim.congressEvidenceState }}</div>
        <p v-if="claim.congressEvidenceSummary" class="text-sm text-slate-400">{{ claim.congressEvidenceSummary }}</p>
        <div v-if="claim.congressEvidenceSources && (claim.congressEvidenceSources as unknown[]).length > 0" class="mt-2 space-y-1">
          <div v-for="(source, i) in (claim.congressEvidenceSources as Array<Record<string, unknown>>)" :key="i" class="text-xs text-slate-500">
            {{ source.title }} — {{ source.latestAction }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
