import { ref, computed } from 'vue';
import { defineStore } from 'pinia';

export interface Claim {
  claimId: string;
  runId: string | null;
  claim: string;
  status: string;
  verdict: string;
  confidence: number;
  summary: string | null;
  sources: Array<{ publisher: string; url: string | null; title: string | null; textualRating: string; claimReviewed: string; reviewDate: string | null }>;
  chunkStartSec: number;
  chunkStartClock: string;
  claimCategory: string;
  claimTypeTag: string;
  claimTypeConfidence: number;
  googleEvidenceState: string;
  fredEvidenceState: string;
  fredEvidenceSummary: string | null;
  fredEvidenceSources: unknown[];
  congressEvidenceState: string;
  congressEvidenceSummary: string | null;
  congressEvidenceSources: unknown[];
  correctedClaim: string | null;
  aiSummary: string | null;
  aiVerdict: string | null;
  aiConfidence: number | null;
  evidenceBasis: string | null;
  outputApprovalState: string;
  outputPackageStatus: string;
  renderStatus: string;
  renderJobId: string | null;
  artifactUrl: string | null;
  approvalEligibility?: boolean;
  approvalBlockReason?: string | null;
  exportEligibility?: boolean;
  exportBlockReason?: string | null;
  approvedVersion: number | null;
  version: number;
  updatedAt: string;
}

const BASE_URL = '';

function authHeaders(): Record<string, string> {
  const pw = localStorage.getItem('controlPassword');
  return pw ? { 'x-control-password': pw } : {};
}

async function apiPost(path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  return res.json() as Promise<Record<string, unknown>>;
}

export const useFactcheckStore = defineStore('factcheck', () => {
  const claims = ref<Map<string, Claim>>(new Map());
  const running = ref(false);
  const runId = ref<string | null>(null);
  const selectedClaimId = ref<string | null>(null);
  const authRequired = ref(false);
  const authenticated = ref(false);
  const sseConnected = ref(false);
  const transcriptSegments = ref<Array<{ text: string; at: string }>>([]);
  const healthData = ref<Record<string, unknown>>({});

  let eventSource: EventSource | null = null;

  const claimsList = computed(() =>
    Array.from(claims.value.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  );

  const selectedClaim = computed(() =>
    selectedClaimId.value ? claims.value.get(selectedClaimId.value) ?? null : null
  );

  const pendingClaims = computed(() => claimsList.value.filter(c => c.outputApprovalState === 'pending'));
  const approvedClaims = computed(() => claimsList.value.filter(c => c.outputApprovalState === 'approved'));

  function updateClaimFromEvent(data: Record<string, unknown>) {
    const id = data.claimId as string;
    if (!id) return;
    const existing = claims.value.get(id);
    const merged = { ...(existing ?? {}), ...data } as Claim;
    claims.value.set(id, merged);
  }

  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    const pw = localStorage.getItem('controlPassword');
    const url = pw ? `${BASE_URL}/events?control_password=${encodeURIComponent(pw)}` : `${BASE_URL}/events`;
    eventSource = new EventSource(url);
    eventSource.onopen = () => { sseConnected.value = true; };
    eventSource.onerror = () => { sseConnected.value = false; };

    const claimEvents = [
      'claim.detected', 'claim.researching', 'claim.updated',
      'claim.output_approved', 'claim.output_rejected',
      'claim.output_package_queued', 'claim.output_package_ready', 'claim.output_package_failed',
      'claim.render_queued', 'claim.render_ready', 'claim.render_failed',
    ];
    for (const eventType of claimEvents) {
      eventSource.addEventListener(eventType, (e) => {
        const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        updateClaimFromEvent(data);
      });
    }

    eventSource.addEventListener('pipeline.started', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
      running.value = true;
      runId.value = (data.runId as string) ?? null;
      claims.value.clear();
      transcriptSegments.value = [];
    });

    eventSource.addEventListener('pipeline.stopped', () => {
      running.value = false;
    });

    eventSource.addEventListener('pipeline.transcript', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
      transcriptSegments.value.push({ text: data.transcript as string, at: data.at as string });
      if (transcriptSegments.value.length > 200) transcriptSegments.value.shift();
    });
  }

  async function checkAuth() {
    const res = await apiGet('/auth-status');
    authRequired.value = Boolean(res.authRequired);
    if (!authRequired.value) { authenticated.value = true; return; }
    const pw = localStorage.getItem('controlPassword');
    if (!pw) { authenticated.value = false; return; }
    const health = await apiGet('/health');
    authenticated.value = health.ok === true;
  }

  function login(password: string) {
    localStorage.setItem('controlPassword', password);
    authenticated.value = true;
    connectSSE();
    void loadClaims();
  }

  function logout() {
    localStorage.removeItem('controlPassword');
    authenticated.value = false;
    if (eventSource) { eventSource.close(); eventSource = null; }
  }

  async function loadClaims() {
    const res = await apiGet('/api/claims');
    running.value = Boolean(res.running);
    runId.value = (res.runId as string) ?? null;
    const list = (res.claims ?? []) as Claim[];
    claims.value.clear();
    for (const c of list) claims.value.set(c.claimId, c);
  }

  async function loadHealth() {
    healthData.value = await apiGet('/health');
  }

  async function startPipeline(youtubeUrl: string, opts: Record<string, unknown> = {}) {
    return apiPost('/api/start', { youtubeUrl, ...opts });
  }

  async function stopPipeline() {
    return apiPost('/api/stop');
  }

  async function approveClaim(claimId: string, expectedVersion: number) {
    return apiPost(`/api/claims/${encodeURIComponent(claimId)}/approve-output`, { expectedVersion });
  }

  async function rejectClaim(claimId: string, expectedVersion: number, reason?: string) {
    return apiPost(`/api/claims/${encodeURIComponent(claimId)}/reject-output`, { expectedVersion, reason });
  }

  async function triggerRender(claimId: string, expectedVersion: number, force = false) {
    return apiPost(`/api/claims/${encodeURIComponent(claimId)}/render-image`, { expectedVersion, force });
  }

  async function overrideTag(claimId: string, expectedVersion: number, tag: string, reason: string) {
    return apiPost(`/api/claims/${encodeURIComponent(claimId)}/tag-override`, { expectedVersion, tag, reason });
  }

  function selectClaim(id: string | null) {
    selectedClaimId.value = id;
  }

  function init() {
    void checkAuth().then(() => {
      if (authenticated.value) {
        connectSSE();
        void loadClaims();
        void loadHealth();
      }
    });
  }

  return {
    claims, claimsList, selectedClaim, selectedClaimId, running, runId,
    authRequired, authenticated, sseConnected, transcriptSegments, healthData,
    pendingClaims, approvedClaims,
    init, login, logout, loadClaims, loadHealth, connectSSE,
    startPipeline, stopPipeline, approveClaim, rejectClaim, triggerRender, overrideTag,
    selectClaim,
  };
});
