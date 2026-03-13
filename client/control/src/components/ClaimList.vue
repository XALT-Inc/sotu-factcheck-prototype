<script setup lang="ts">
import { ref, computed } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import type { Claim } from '../stores/factcheck';
import VerdictBadge from './VerdictBadge.vue';
import { AlertTriangle } from 'lucide-vue-next';

const store = useFactcheckStore();
const filter = ref<'all' | 'pending' | 'approved' | 'rejected'>('all');

const rejectedCount = computed(() => store.claimsList.filter(c => c.outputApprovalState === 'rejected').length);

const filtered = computed(() => {
  if (filter.value === 'pending') return store.claimsList.filter(c => c.outputApprovalState === 'pending');
  if (filter.value === 'approved') return store.claimsList.filter(c => c.outputApprovalState === 'approved');
  if (filter.value === 'rejected') return store.claimsList.filter(c => c.outputApprovalState === 'rejected');
  return store.claimsList;
});

const categoryColors: Record<string, string> = {
  economic: 'bg-blue-500/10 text-blue-600',
  political: 'bg-purple-500/10 text-purple-600',
  legislative: 'bg-indigo-500/10 text-indigo-600',
};

function categoryClass(claim: Claim): string {
  const cat = (claim.claimCategory ?? '').toLowerCase();
  return categoryColors[cat] ?? 'bg-secondary text-muted-foreground';
}

function stageColor(active: boolean, partial: boolean, error: boolean): string {
  if (error) return 'bg-destructive';
  if (active) return 'bg-success';
  if (partial) return 'bg-warning';
  return 'bg-muted-foreground/30';
}

function stageDetected(): string { return 'bg-success'; }

function stageResearching(claim: Claim): string {
  if (claim.status === 'researched' || claim.status === 'no_match') return 'bg-success';
  if (claim.status === 'researching') return 'bg-warning';
  if (claim.status === 'pending_research') return 'bg-muted-foreground/30';
  return 'bg-success'; // default: assume done
}

function stageVerified(claim: Claim): string {
  const es = claim.evidenceStatus;
  if (es === 'sufficient') return 'bg-success';
  if (es === 'conflicted') return 'bg-destructive';
  if (es === 'researching' || !es) return stageResearching(claim) === 'bg-success' ? 'bg-warning' : 'bg-muted-foreground/30';
  return 'bg-warning';
}

function stageApproved(claim: Claim): string {
  if (claim.outputApprovalState === 'approved') return 'bg-success';
  if (claim.outputApprovalState === 'rejected') return 'bg-destructive';
  return 'bg-muted-foreground/30';
}

function stageRendered(claim: Claim): string {
  if (claim.renderStatus === 'ready') return 'bg-success';
  if (claim.renderStatus === 'queued' || claim.renderStatus === 'rendering') return 'bg-warning';
  if (claim.renderStatus === 'failed') return 'bg-destructive';
  return 'bg-muted-foreground/30';
}
</script>

<template>
  <div class="flex-1 overflow-hidden flex flex-col">
    <!-- Filter tabs -->
    <div class="flex border-b border-border text-xs">
      <button v-for="f in ['all', 'pending', 'approved', 'rejected'] as const" :key="f"
        @click="filter = f"
        :class="filter === f ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'"
        class="flex-1 py-2 capitalize transition-colors">
        {{ f }}
        <span class="ml-1 text-muted-foreground/50" v-if="f === 'all'">({{ store.claimsList.length }})</span>
        <span class="ml-1 text-muted-foreground/50" v-else-if="f === 'pending'">({{ store.pendingClaims.length }})</span>
        <span class="ml-1 text-muted-foreground/50" v-else-if="f === 'approved'">({{ store.approvedClaims.length }})</span>
        <span class="ml-1 text-muted-foreground/50" v-else-if="f === 'rejected'">({{ rejectedCount }})</span>
      </button>
    </div>

    <!-- Claims -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="filtered.length === 0" class="p-4 text-center text-muted-foreground text-sm">No claims</div>
      <div v-for="claim in filtered" :key="claim.claimId"
        @click="store.selectClaim(claim.claimId)"
        :class="store.selectedClaimId === claim.claimId ? 'bg-accent border-l-2 border-primary' : 'border-l-2 border-transparent hover:bg-accent'"
        class="p-3 border-b border-border/50 cursor-pointer transition-all duration-200">
        <!-- Header row: verdict + category + timecode + source count -->
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <VerdictBadge :verdict="claim.verdict" />
          <span v-if="claim.claimCategory" :class="categoryClass(claim)" class="text-xs px-1.5 py-0.5 rounded">
            {{ claim.claimCategory }}
          </span>
          <span class="text-xs text-muted-foreground font-mono">{{ claim.chunkStartClock }}</span>
          <span v-if="claim.independentSourceCount" class="text-xs text-muted-foreground">{{ claim.independentSourceCount }} src</span>
          <AlertTriangle v-if="claim.evidenceConflict" class="w-3 h-3 text-warning" />
          <span v-if="claim.outputApprovalState === 'approved'" class="text-xs text-success">Approved</span>
          <span v-if="claim.renderStatus === 'ready'" class="text-xs text-primary">Rendered</span>
        </div>

        <!-- Claim text -->
        <p class="text-sm text-card-foreground line-clamp-2">{{ claim.claim }}</p>

        <!-- Research status -->
        <span v-if="claim.status === 'researching'" class="text-xs text-info">Researching...</span>
        <span v-else-if="claim.status === 'pending_research'" class="text-xs text-muted-foreground">Queued for research</span>

        <!-- Confidence bar -->
        <div class="flex items-center gap-2 mt-1">
          <div class="flex-1 h-1 bg-muted rounded-full overflow-hidden">
            <div class="h-full rounded-full" :class="claim.confidence >= 0.7 ? 'bg-green-500' : claim.confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500'" :style="{ width: `${Math.round(claim.confidence * 100)}%` }"></div>
          </div>
          <span class="text-xs text-muted-foreground">{{ Math.round(claim.confidence * 100) }}%</span>
        </div>

        <!-- Workflow stage dots -->
        <div class="flex items-center gap-1 mt-1.5" title="Detected · Research · Verify · Approve · Render">
          <span class="w-1.5 h-1.5 rounded-full" :class="stageDetected()" />
          <span class="w-1.5 h-1.5 rounded-full" :class="stageResearching(claim)" />
          <span class="w-1.5 h-1.5 rounded-full" :class="stageVerified(claim)" />
          <span class="w-1.5 h-1.5 rounded-full" :class="stageApproved(claim)" />
          <span class="w-1.5 h-1.5 rounded-full" :class="stageRendered(claim)" />
        </div>
      </div>
    </div>
  </div>
</template>
