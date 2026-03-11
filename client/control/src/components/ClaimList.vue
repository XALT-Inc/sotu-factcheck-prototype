<script setup lang="ts">
import { ref, computed } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import VerdictBadge from './VerdictBadge.vue';

const store = useFactcheckStore();
const filter = ref<'all' | 'pending' | 'approved' | 'rejected'>('all');

const filtered = computed(() => {
  if (filter.value === 'pending') return store.claimsList.filter(c => c.outputApprovalState === 'pending');
  if (filter.value === 'approved') return store.claimsList.filter(c => c.outputApprovalState === 'approved');
  if (filter.value === 'rejected') return store.claimsList.filter(c => c.outputApprovalState === 'rejected');
  return store.claimsList;
});
</script>

<template>
  <div class="flex-1 overflow-hidden flex flex-col">
    <!-- Filter tabs -->
    <div class="flex border-b border-slate-800 text-xs">
      <button v-for="f in ['all', 'pending', 'approved', 'rejected'] as const" :key="f"
        @click="filter = f"
        :class="filter === f ? 'text-blue-400 border-b-2 border-blue-400' : 'text-slate-500 hover:text-slate-300'"
        class="flex-1 py-2 capitalize">
        {{ f }}
        <span class="ml-1 text-slate-600" v-if="f === 'all'">({{ store.claimsList.length }})</span>
        <span class="ml-1 text-slate-600" v-else-if="f === 'pending'">({{ store.pendingClaims.length }})</span>
        <span class="ml-1 text-slate-600" v-else-if="f === 'approved'">({{ store.approvedClaims.length }})</span>
      </button>
    </div>

    <!-- Claims -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="filtered.length === 0" class="p-4 text-center text-slate-600 text-sm">No claims</div>
      <div v-for="claim in filtered" :key="claim.claimId"
        @click="store.selectClaim(claim.claimId)"
        :class="store.selectedClaimId === claim.claimId ? 'bg-slate-800/80 border-l-2 border-blue-500' : 'border-l-2 border-transparent hover:bg-slate-900'"
        class="p-3 border-b border-slate-800/50 cursor-pointer">
        <div class="flex items-center gap-2 mb-1">
          <VerdictBadge :verdict="claim.verdict" />
          <span class="text-xs text-slate-500 font-mono">{{ claim.chunkStartClock }}</span>
          <span v-if="claim.outputApprovalState === 'approved'" class="text-xs text-green-500">Approved</span>
          <span v-if="claim.renderStatus === 'ready'" class="text-xs text-purple-400">Rendered</span>
        </div>
        <p class="text-sm text-slate-300 line-clamp-2">{{ claim.claim }}</p>
        <div class="flex items-center gap-2 mt-1">
          <div class="flex-1 h-1 bg-slate-800 rounded overflow-hidden">
            <div class="h-full rounded" :class="claim.confidence >= 0.7 ? 'bg-green-500' : claim.confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500'" :style="{ width: `${Math.round(claim.confidence * 100)}%` }"></div>
          </div>
          <span class="text-xs text-slate-500">{{ Math.round(claim.confidence * 100) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>
