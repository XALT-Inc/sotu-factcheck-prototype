<script setup lang="ts">
import { ref } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import VerdictBadge from './VerdictBadge.vue';
import EvidencePanel from './EvidencePanel.vue';
import RenderPreview from './RenderPreview.vue';

const store = useFactcheckStore();
const actionError = ref('');
const tagOverrideReason = ref('');
const showTagOverride = ref(false);

async function approve() {
  actionError.value = '';
  const claim = store.selectedClaim;
  if (!claim) return;
  const res = await store.approveClaim(claim.claimId, claim.version);
  if (!res.ok) actionError.value = (res.error as string) ?? 'Approve failed';
}

async function reject() {
  actionError.value = '';
  const claim = store.selectedClaim;
  if (!claim) return;
  const res = await store.rejectClaim(claim.claimId, claim.version);
  if (!res.ok) actionError.value = (res.error as string) ?? 'Reject failed';
}

async function render(force = false) {
  actionError.value = '';
  const claim = store.selectedClaim;
  if (!claim) return;
  const res = await store.triggerRender(claim.claimId, claim.version, force);
  if (!res.ok) actionError.value = (res.error as string) ?? 'Render failed';
}

async function submitTagOverride(tag: string) {
  actionError.value = '';
  const claim = store.selectedClaim;
  if (!claim) return;
  if (!tagOverrideReason.value.trim()) { actionError.value = 'Reason is required for tag override'; return; }
  const res = await store.overrideTag(claim.claimId, claim.version, tag, tagOverrideReason.value.trim());
  if (!res.ok) actionError.value = (res.error as string) ?? 'Tag override failed';
  else { showTagOverride.value = false; tagOverrideReason.value = ''; }
}
</script>

<template>
  <div v-if="store.selectedClaim" class="p-6 space-y-6">
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3 mb-2">
          <VerdictBadge :verdict="store.selectedClaim.verdict" />
          <span class="text-xs text-slate-500 font-mono">{{ store.selectedClaim.chunkStartClock }}</span>
          <span class="text-xs px-2 py-0.5 bg-slate-800 rounded text-slate-400">{{ store.selectedClaim.claimTypeTag }}</span>
          <span class="text-xs text-slate-600">v{{ store.selectedClaim.version }}</span>
        </div>
        <p class="text-lg text-slate-200">{{ store.selectedClaim.claim }}</p>
      </div>
      <button @click="store.selectClaim(null)" class="text-slate-500 hover:text-slate-300 text-xl">&times;</button>
    </div>

    <!-- Corrected claim -->
    <div v-if="store.selectedClaim.correctedClaim" class="bg-slate-900 border-l-4 border-green-600 p-4 rounded-r">
      <div class="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">Actual</div>
      <p class="text-slate-300">{{ store.selectedClaim.correctedClaim }}</p>
    </div>

    <!-- AI Summary -->
    <div v-if="store.selectedClaim.aiSummary" class="text-slate-400 text-sm leading-relaxed">
      {{ store.selectedClaim.aiSummary }}
    </div>

    <!-- Confidence -->
    <div class="flex items-center gap-3">
      <span class="text-sm text-slate-500">Confidence:</span>
      <div class="flex-1 max-w-xs h-2 bg-slate-800 rounded overflow-hidden">
        <div class="h-full rounded" :class="store.selectedClaim.confidence >= 0.7 ? 'bg-green-500' : store.selectedClaim.confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500'" :style="{ width: `${Math.round(store.selectedClaim.confidence * 100)}%` }"></div>
      </div>
      <span class="text-sm font-mono">{{ Math.round(store.selectedClaim.confidence * 100) }}%</span>
      <span class="text-xs text-slate-600">(threshold: {{ store.selectedClaim.claimTypeTag === 'numeric_factual' ? '60%' : store.selectedClaim.claimTypeTag === 'simple_policy' ? '75%' : '80%' }})</span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-3">
      <button @click="approve" :disabled="!store.selectedClaim.approvalEligibility"
        :class="store.selectedClaim.approvalEligibility ? 'bg-green-700 hover:bg-green-600' : 'bg-slate-800 text-slate-600 cursor-not-allowed'"
        class="px-4 py-2 rounded text-sm font-medium text-white">
        {{ store.selectedClaim.outputApprovalState === 'approved' ? 'Approved' : 'Approve' }}
      </button>
      <button @click="reject" class="px-4 py-2 rounded text-sm font-medium bg-red-800 hover:bg-red-700 text-white">Reject</button>
      <button @click="render()" :disabled="!store.selectedClaim.exportEligibility"
        :class="store.selectedClaim.exportEligibility ? 'bg-purple-700 hover:bg-purple-600' : 'bg-slate-800 text-slate-600 cursor-not-allowed'"
        class="px-4 py-2 rounded text-sm font-medium text-white">Render</button>
      <button @click="showTagOverride = !showTagOverride" class="px-3 py-2 rounded text-xs bg-slate-800 hover:bg-slate-700 text-slate-300">Tag Override</button>
    </div>

    <!-- Tag override form -->
    <div v-if="showTagOverride" class="bg-slate-900 p-4 rounded space-y-2">
      <div class="flex gap-2">
        <button v-for="tag in ['numeric_factual', 'simple_policy', 'other']" :key="tag"
          @click="submitTagOverride(tag)"
          :class="store.selectedClaim?.claimTypeTag === tag ? 'bg-blue-700' : 'bg-slate-800 hover:bg-slate-700'"
          class="px-3 py-1 rounded text-xs text-slate-200">{{ tag }}</button>
      </div>
      <input v-model="tagOverrideReason" placeholder="Reason for override (required)" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs focus:outline-none" />
    </div>

    <p v-if="actionError" class="text-red-400 text-sm">{{ actionError }}</p>

    <!-- Block reason display -->
    <p v-if="store.selectedClaim.approvalBlockReason" class="text-xs text-amber-500">
      Approval blocked: {{ store.selectedClaim.approvalBlockReason }}
    </p>

    <!-- Evidence -->
    <EvidencePanel :claim="store.selectedClaim" />

    <!-- Render preview -->
    <RenderPreview :claim="store.selectedClaim" />
  </div>
</template>
