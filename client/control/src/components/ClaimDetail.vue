<script setup lang="ts">
import { ref, computed } from 'vue';
import { useFactcheckStore } from '../stores/factcheck';
import VerdictBadge from './VerdictBadge.vue';
import EvidencePanel from './EvidencePanel.vue';
import RenderPreview from './RenderPreview.vue';
import { X, AlertTriangle } from 'lucide-vue-next';

const store = useFactcheckStore();
const actionError = ref('');
const tagOverrideReason = ref('');
const showTagOverride = ref(false);
const approving = ref(false);
const rejecting = ref(false);
const rendering = ref(false);

const claim = computed(() => store.selectedClaim);

const blockReasonLabel = computed(() => {
  const reason = claim.value?.approvalBlockReason;
  if (!reason) return null;
  const labels: Record<string, string> = {
    still_researching: 'Still gathering evidence from research providers',
    insufficient_sources: 'Not enough independent sources to verify',
    conflicted_sources: 'Evidence sources disagree — manual review needed',
    below_threshold: `Confidence (${Math.round((claim.value?.confidence ?? 0) * 100)}%) is below the required threshold`,
    rejected_locked: 'This claim has been rejected and is locked',
  };
  return labels[reason] ?? reason;
});

const evidenceStatusClass = computed(() => {
  const es = claim.value?.evidenceStatus;
  if (es === 'sufficient') return 'bg-success/15 text-success';
  if (es === 'insufficient') return 'bg-warning/15 text-warning';
  if (es === 'conflicted') return 'bg-destructive/15 text-destructive';
  if (es === 'researching') return 'bg-info/15 text-info';
  return 'bg-secondary text-muted-foreground';
});

const categoryColors: Record<string, string> = {
  economic: 'bg-blue-500/10 text-blue-600',
  political: 'bg-purple-500/10 text-purple-600',
  legislative: 'bg-indigo-500/10 text-indigo-600',
};

function categoryClass(): string {
  const cat = (claim.value?.claimCategory ?? '').toLowerCase();
  return categoryColors[cat] ?? 'bg-secondary text-muted-foreground';
}

function detectedAgo(): string {
  if (!claim.value?.detectedAt) return '';
  const ms = Date.now() - new Date(claim.value.detectedAt).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

async function approve() {
  actionError.value = '';
  if (!claim.value) return;
  approving.value = true;
  const res = await store.approveClaim(claim.value.claimId, claim.value.version);
  approving.value = false;
  if (!res.ok) actionError.value = (res.error as string) ?? 'Approve failed';
}

async function reject() {
  actionError.value = '';
  if (!claim.value) return;
  if (!window.confirm('Reject this claim? This cannot be undone.')) return;
  rejecting.value = true;
  const res = await store.rejectClaim(claim.value.claimId, claim.value.version);
  rejecting.value = false;
  if (!res.ok) actionError.value = (res.error as string) ?? 'Reject failed';
}

async function render(force = false) {
  actionError.value = '';
  if (!claim.value) return;
  rendering.value = true;
  const res = await store.triggerRender(claim.value.claimId, claim.value.version, force);
  rendering.value = false;
  if (!res.ok) actionError.value = (res.error as string) ?? 'Render failed';
}

async function submitTagOverride(tag: string) {
  actionError.value = '';
  if (!claim.value) return;
  if (!tagOverrideReason.value.trim()) { actionError.value = 'Reason is required for tag override'; return; }
  const res = await store.overrideTag(claim.value.claimId, claim.value.version, tag, tagOverrideReason.value.trim());
  if (!res.ok) actionError.value = (res.error as string) ?? 'Tag override failed';
  else { showTagOverride.value = false; tagOverrideReason.value = ''; }
}
</script>

<template>
  <div v-if="claim" class="p-6 space-y-0">
    <!-- Header -->
    <div class="flex items-start justify-between pb-4">
      <div>
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <VerdictBadge :verdict="claim.verdict" />
          <span v-if="claim.claimCategory" :class="categoryClass()" class="text-xs px-1.5 py-0.5 rounded">
            {{ claim.claimCategory }}
          </span>
          <span v-if="claim.evidenceBasis" class="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            {{ claim.evidenceBasis }}
          </span>
        </div>
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span class="font-mono">{{ claim.chunkStartClock }}</span>
          <span>&middot;</span>
          <span>v{{ claim.version }}</span>
          <span v-if="detectedAgo()">&middot; detected {{ detectedAgo() }}</span>
        </div>
      </div>
      <button @click="store.selectClaim(null)" class="text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg p-1.5 transition-colors">
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Claim text -->
    <div class="pb-4">
      <p class="text-lg text-foreground leading-relaxed">{{ claim.claim }}</p>
    </div>

    <!-- Corrected claim -->
    <div v-if="claim.correctedClaim" class="border-t border-border pt-4 pb-4">
      <div class="bg-card border-l-4 border-success p-4 rounded-lg">
        <div class="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-1">Correction</div>
        <p class="text-card-foreground">{{ claim.correctedClaim }}</p>
      </div>
    </div>

    <!-- AI Analysis section -->
    <div v-if="claim.aiVerdict || claim.aiSummary" class="border-t border-border pt-4 pb-4">
      <h4 class="text-sm font-semibold text-foreground mb-3">AI Analysis</h4>
      <div class="bg-card border border-border rounded-lg p-4 space-y-3">
        <div v-if="claim.aiVerdict" class="flex items-center gap-3">
          <span class="text-sm text-muted-foreground">Verdict:</span>
          <VerdictBadge :verdict="claim.aiVerdict" />
          <span v-if="claim.aiConfidence != null" class="text-sm font-mono">{{ Math.round(claim.aiConfidence * 100) }}%</span>
        </div>
        <p v-if="claim.aiSummary" class="text-sm text-muted-foreground leading-relaxed">{{ claim.aiSummary }}</p>
      </div>
    </div>

    <!-- Policy Evaluation section -->
    <div class="border-t border-border pt-4 pb-4">
      <h4 class="text-sm font-semibold text-foreground mb-3">Policy Evaluation</h4>
      <div class="bg-card border border-border rounded-lg p-4 space-y-3">
        <!-- Confidence bar -->
        <div class="flex items-center gap-3">
          <span class="text-sm text-muted-foreground">Confidence:</span>
          <div class="flex-1 max-w-xs h-2 bg-muted rounded-full overflow-hidden">
            <div class="h-full rounded-full" :class="claim.confidence >= 0.7 ? 'bg-green-500' : claim.confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500'" :style="{ width: `${Math.round(claim.confidence * 100)}%` }"></div>
          </div>
          <span class="text-sm font-mono">{{ Math.round(claim.confidence * 100) }}%</span>
          <span v-if="claim.policyThreshold != null" class="text-xs text-muted-foreground/50">(threshold: {{ Math.round(claim.policyThreshold * 100) }}%)</span>
          <span v-else class="text-xs text-muted-foreground/50">(threshold: {{ claim.claimTypeTag === 'numeric_factual' ? '60%' : claim.claimTypeTag === 'simple_policy' ? '75%' : '80%' }})</span>
        </div>

        <!-- Evidence status + source count -->
        <div class="flex items-center gap-3 flex-wrap">
          <span class="text-sm text-muted-foreground">Evidence:</span>
          <span v-if="claim.evidenceStatus" :class="evidenceStatusClass" class="px-2 py-0.5 rounded-full text-xs font-medium">
            {{ claim.evidenceStatus }}
          </span>
          <span v-if="claim.independentSourceCount != null" class="text-sm text-muted-foreground">
            {{ claim.independentSourceCount }} independent source{{ claim.independentSourceCount === 1 ? '' : 's' }}
          </span>
        </div>

        <!-- Conflict warning -->
        <div v-if="claim.evidenceConflict" class="flex items-center gap-2 text-sm text-warning">
          <AlertTriangle class="w-4 h-4" />
          Evidence sources have conflicting findings
        </div>
      </div>
    </div>

    <!-- Approval block reason -->
    <div v-if="claim.approvalBlockReason" class="pb-4">
      <div class="bg-warning/10 border border-warning/30 rounded-lg p-3 flex items-start gap-2">
        <AlertTriangle class="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div>
          <div class="text-sm font-medium text-warning">Approval blocked</div>
          <div class="text-sm text-muted-foreground">{{ blockReasonLabel }}</div>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="border-t border-border pt-4 pb-4">
      <div class="flex items-center gap-3">
        <button @click="approve" :disabled="!claim.approvalEligibility || approving"
          :class="claim.approvalEligibility ? 'bg-success hover:bg-success/90' : 'bg-muted text-muted-foreground border-border cursor-not-allowed'"
          class="h-10 px-4 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50">
          {{ approving ? 'Approving...' : claim.outputApprovalState === 'approved' ? 'Approved' : 'Approve' }}
        </button>
        <button @click="reject" :disabled="rejecting" class="h-10 px-4 rounded-lg text-sm font-medium bg-destructive hover:bg-destructive/90 text-destructive-foreground transition-colors disabled:opacity-50">
          {{ rejecting ? 'Rejecting...' : 'Reject' }}
        </button>
        <button @click="render()" :disabled="!claim.exportEligibility || rendering"
          :class="claim.exportEligibility ? 'bg-primary hover:bg-primary/90 text-primary-foreground' : 'bg-muted text-muted-foreground border-border cursor-not-allowed'"
          class="h-10 px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
          {{ rendering ? 'Rendering...' : 'Render' }}
        </button>
        <button @click="showTagOverride = !showTagOverride" class="h-8 px-3 rounded-lg text-xs bg-secondary hover:bg-accent text-secondary-foreground transition-colors">Tag Override</button>
      </div>

      <!-- Tag override form -->
      <div v-if="showTagOverride" class="mt-3 bg-card p-4 rounded-lg space-y-2 border border-border">
        <div class="flex gap-2">
          <button v-for="tag in ['numeric_factual', 'simple_policy', 'other']" :key="tag"
            @click="submitTagOverride(tag)"
            :class="claim.claimTypeTag === tag ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-accent text-secondary-foreground'"
            class="px-3 py-1 rounded-lg text-xs transition-colors">{{ tag }}</button>
        </div>
        <input v-model="tagOverrideReason" placeholder="Reason for override (required)" class="w-full bg-background border border-input rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors" />
      </div>

      <p v-if="actionError" class="text-destructive text-sm mt-2">{{ actionError }}</p>
    </div>

    <!-- Evidence Sources -->
    <div class="border-t border-border pt-4 pb-4">
      <h4 class="text-sm font-semibold text-foreground mb-3">Evidence Sources</h4>
      <EvidencePanel :claim="claim" />
    </div>

    <!-- Render -->
    <div class="border-t border-border pt-4">
      <RenderPreview :claim="claim" />
    </div>
  </div>
</template>
