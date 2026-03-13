// ── Verdict & Status Enums ──────────────────────────────────────────────────

export type Verdict = 'true' | 'false' | 'misleading' | 'unverified';
export type EvidenceBasis = 'fact_check_match' | 'fred_data' | 'congress_data' | 'general_knowledge' | 'mixed';
export type ClaimCategory = 'economic' | 'political' | 'legislative' | 'general';
export type ClaimTypeTag = 'numeric_factual' | 'simple_policy' | 'other';
export type ApprovalState = 'pending' | 'approved' | 'rejected';
export type PackageStatus = 'none' | 'queued' | 'ready' | 'failed';
export type RenderStatus = 'none' | 'queued' | 'rendering' | 'ready' | 'failed';
export type ClaimStatus = 'pending_research' | 'researching' | 'researched' | 'needs_manual_research' | 'no_match' | 'unknown';
export type EvidenceState = 'none' | 'matched' | 'not_applicable' | 'ambiguous' | 'error';

// ── Claim Detection ─────────────────────────────────────────────────────────

export interface DetectedClaim {
  text: string;
  score: number;
  reasons: string[];
  chunkStartSec: number;
  category: ClaimCategory;
  claimTypeTag: ClaimTypeTag;
  claimTypeConfidence: number;
}

export interface ClaimScore {
  score: number;
  reasons: string[];
}

// ── Research Service Results ────────────────────────────────────────────────

export interface FactCheckSource {
  publisher: string;
  url: string | null;
  title: string | null;
  textualRating: string;
  claimReviewed: string;
  reviewDate: string | null;
}

export interface FactCheckResult {
  status: 'researched' | 'no_match' | 'needs_manual_research';
  verdict: Verdict;
  confidence: number;
  summary: string;
  sources: FactCheckSource[];
}

export interface FredObservation {
  seriesId: string;
  seriesTitle: string;
  observationDate: string;
  value: number;
  url: string;
}

export interface FredResult {
  state: EvidenceState;
  summary: string;
  sources: FredObservation[];
}

export interface CongressBillDetails {
  congress: number;
  type: string;
  number: number;
  title: string;
  latestAction: string;
  latestActionDate: string | null;
  becameLaw: boolean;
  cosponsors: number;
  url: string;
}

export interface CongressResult {
  state: EvidenceState;
  summary: string;
  sources: CongressBillDetails[];
}

// ── Gemini Verifier ─────────────────────────────────────────────────────────

export interface VerificationEvidence {
  googleFc?: {
    verdict: Verdict;
    confidence: number;
    summary: string;
    sources: FactCheckSource[];
  };
  fred?: {
    state: EvidenceState;
    summary: string;
    sources: FredObservation[];
  };
  congress?: {
    state: EvidenceState;
    summary: string;
    sources: CongressBillDetails[];
  };
  claimCategory?: ClaimCategory;
  claimTypeTag?: ClaimTypeTag;
  currentDate?: string;
  speechContext?: string;
  operatorNotes?: string;
}

export interface VerificationResult {
  aiVerdict: Verdict;
  aiConfidence: number;
  correctedClaim: string | null;
  aiSummary: string | null;
  evidenceBasis: EvidenceBasis | null;
}

// ── Policy Engine ───────────────────────────────────────────────────────────

export type ApprovalBlockReason =
  | 'rejected_locked'
  | 'still_researching'
  | 'not_researched'
  | 'provider_degraded'
  | 'insufficient_sources'
  | 'conflicted_sources'
  | 'below_threshold'
  | null;

export type ExportBlockReason = ApprovalBlockReason | 'not_approved';

export interface PolicyEvaluation {
  claimTypeTag: ClaimTypeTag;
  claimTypeConfidence: number;
  policyThreshold: number;
  independentSourceCount: number;
  evidenceConflict: boolean;
  evidenceStatus: string;
  approvalEligibility: boolean;
  approvalBlockReason: ApprovalBlockReason;
  exportEligibility: boolean;
  exportBlockReason: ExportBlockReason;
}

// ── Claim State ─────────────────────────────────────────────────────────────

export interface Claim {
  claimId: string;
  runId: string | null;
  claim: string;
  status: string;
  verdict: Verdict;
  confidence: number;
  summary: string | null;
  sources: FactCheckSource[];
  reasons?: string[];
  chunkStartSec: number;
  chunkStartClock: string;
  claimCategory: ClaimCategory;
  claimTypeTag: ClaimTypeTag;
  claimTypeConfidence: number;
  googleEvidenceState: EvidenceState;
  fredEvidenceState: EvidenceState;
  fredEvidenceSummary: string | null;
  fredEvidenceSources: FredObservation[];
  congressEvidenceState: EvidenceState;
  congressEvidenceSummary: string | null;
  congressEvidenceSources: CongressBillDetails[];
  correctedClaim: string | null;
  aiSummary: string | null;
  aiVerdict: Verdict | null;
  aiConfidence: number | null;
  evidenceBasis: EvidenceBasis | null;
  googleFcVerdict: Verdict | null;
  googleFcConfidence: number | null;
  googleFcSummary: string | null;
  outputApprovalState: ApprovalState;
  outputPackageStatus: PackageStatus;
  outputPackageId: string | null;
  outputPackageError: string | null;
  renderStatus: RenderStatus;
  renderJobId: string | null;
  artifactUrl: string | null;
  renderError: string | null;
  approvedAt: string | null;
  approvedVersion: number | null;
  rejectedAt: string | null;
  detectedAt: string | null;
  updatedAt: string;
  version: number;
  // Policy fields (computed)
  policyThreshold?: number;
  independentSourceCount?: number;
  evidenceConflict?: boolean;
  evidenceStatus?: string;
  approvalEligibility?: boolean;
  approvalBlockReason?: ApprovalBlockReason;
  exportEligibility?: boolean;
  exportBlockReason?: ExportBlockReason;
  requiresProducerApproval?: boolean;
}

// ── Shared Output Interface (A3) ────────────────────────────────────────────

export interface ClaimForOutput {
  claimId: string;
  runId?: string | null;
  version?: number | null;
  claim?: string | null;
  correctedClaim?: string | null;
  verdict?: string | null;
  confidence?: number | null;
  summary?: string | null;
  chunkStartClock?: string | null;
  sources?: Array<{
    publisher?: string;
    title?: string | null;
    url?: string | null;
    textualRating?: string | null;
    reviewDate?: string | null;
  }>;
  fredEvidenceState?: string;
  fredEvidenceSummary?: string | null;
  fredEvidenceSources?: unknown[];
  renderTemplateId?: string;
  renderPayload?: Record<string, unknown> | null;
}

// ── Gemini API types (A8) ──────────────────────────────────────────────────

export interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
}

// ── Ingest Source (C0) ──────────────────────────────────────────────────────

export type IngestSourceSpec = { type: 'youtube'; url: string };

export interface IngestSourceCallbacks {
  onData: (pcm: Buffer) => void;
  onEnd: (reason: string) => void;
  onLog: (type: string, payload: Record<string, unknown>) => void;
  onReconnect?: () => void;
}

export interface IngestSource {
  start(): void;
  stop(reason?: string): void;
  getStatus(): IngestStatus;
}

export interface IngestStatus {
  state: string;
  reconnectAttempt: number;
  reconnectEnabled: boolean;
  maxRetries: number;
  lastExitInfo: IngestExitInfo | null;
  lastEventAt: string | null;
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  source: IngestSourceSpec;
  geminiApiKey: string;
  geminiModel?: string;
  geminiVerifyModel?: string;
  factCheckApiKey?: string;
  fredApiKey?: string;
  congressApiKey?: string;
  chunkSeconds?: number;
  maxResearchConcurrency?: number;
  claimDetectionThreshold?: number;
  ingestReconnectEnabled?: boolean;
  ingestMaxRetries?: number;
  ingestRetryBaseMs?: number;
  ingestRetryMaxMs?: number;
  ingestStallTimeoutMs?: number;
  ingestVerboseLogs?: boolean;
  speechContext?: string;
  operatorNotes?: string;
  onEvent?: (event: PipelineEvent) => void;
}

export interface PipelineInstance {
  runId: string;
  start: () => void;
  stop: (reason?: string) => void;
  isRunning: () => boolean;
  getStatus: () => PipelineStatus;
}

export interface PipelineStatus {
  running: boolean;
  ingestState: string;
  reconnectAttempt: number;
  reconnectEnabled: boolean;
  maxRetries: number;
  lastIngestExit: IngestExitInfo | null;
  lastIngestEventAt: string | null;
}

export interface IngestExitInfo {
  ytdlpCode: number | null;
  ytdlpSignal: string | null;
  ffmpegCode: number | null;
  ffmpegSignal: string | null;
}

// ── Pipeline Events (B4 — Discriminated Union) ──────────────────────────────

interface EventBase {
  at?: string;
  seq?: number;
  runId?: string;
  [key: string]: unknown;
}

// Pipeline lifecycle
export interface PipelineStartedEvent extends EventBase {
  type: 'pipeline.started';
  youtubeUrl?: string;
  chunkSeconds?: number;
  model?: string;
}

export interface PipelineStoppedEvent extends EventBase {
  type: 'pipeline.stopped';
  reason?: string;
}

export interface PipelineReconnectEvent extends EventBase {
  type: 'pipeline.reconnect_scheduled' | 'pipeline.reconnect_started' | 'pipeline.reconnect_succeeded';
  attempt?: number;
  delayMs?: number;
}

export interface PipelineInfoEvent extends EventBase {
  type: 'pipeline.log' | 'pipeline.error' | 'pipeline.warning' | 'pipeline.ingest_stalled';
  stage?: string;
  message?: string;
}

// Audio & transcription
export interface AudioChunkEvent extends EventBase {
  type: 'audio.chunk';
  chunkIndex?: number;
  bytes?: number;
}

export interface TranscriptEvent extends EventBase {
  type: 'transcript.segment' | 'transcript.error';
  text?: string;
  chunkIndex?: number;
  segmentId?: string;
  message?: string;
}

// Claim events
export interface ClaimDetectedEvent extends EventBase {
  type: 'claim.detected';
  claimId: string;
  claim: string;
  status: string;
  verdict?: string;
  confidence: number;
  reasons?: string[];
  claimCategory?: string;
  claimTypeTag?: string;
  claimTypeConfidence?: number;
  chunkStartSec: number;
  chunkStartClock: string;
}

export interface ClaimResearchingEvent extends EventBase {
  type: 'claim.researching';
  claimId: string;
  claim?: string;
}

export interface ClaimUpdatedEvent extends EventBase {
  type: 'claim.updated';
  claimId: string;
  claim?: string;
  status: string;
  verdict: string;
  confidence: number;
  summary?: string | null;
  sources?: FactCheckSource[];
  requiresProducerApproval?: boolean;
  claimCategory?: string;
  claimTypeTag?: string;
  claimTypeConfidence?: number;
  googleEvidenceState?: string;
  fredEvidenceState?: string;
  fredEvidenceSummary?: string | null;
  fredEvidenceSources?: unknown[];
  congressEvidenceState?: string;
  congressEvidenceSummary?: string | null;
  congressEvidenceSources?: unknown[];
  correctedClaim?: string | null;
  aiSummary?: string | null;
  aiVerdict?: string | null;
  aiConfidence?: number | null;
  evidenceBasis?: string | null;
  googleFcVerdict?: string | null;
  googleFcConfidence?: number | null;
  googleFcSummary?: string | null;
}

export interface ClaimApprovalEvent extends EventBase {
  type: 'claim.output_approved' | 'claim.output_rejected';
  claimId: string;
  outputApprovalState?: string;
  approvedAt?: string;
  approvedVersion?: number;
  rejectedAt?: string;
}

export interface ClaimOutputPackageEvent extends EventBase {
  type: 'claim.output_package_queued' | 'claim.output_package_ready' | 'claim.output_package_failed';
  claimId: string;
  packageId?: string;
  claimVersion?: number | null;
  error?: string;
  outputPackageStatus?: string;
}

export interface ClaimRenderEvent extends EventBase {
  type: 'claim.render_queued' | 'claim.render_ready' | 'claim.render_failed';
  claimId: string;
  renderJobId?: string;
  claimVersion?: number | null;
  artifactUrl?: string | null;
  error?: string;
  renderStatus?: string;
  idempotencyKey?: string;
}

export type ClaimEvent =
  | ClaimDetectedEvent | ClaimResearchingEvent | ClaimUpdatedEvent
  | ClaimApprovalEvent | ClaimOutputPackageEvent | ClaimRenderEvent;

export type PipelineEvent =
  | PipelineStartedEvent | PipelineStoppedEvent | PipelineReconnectEvent | PipelineInfoEvent
  | AudioChunkEvent | TranscriptEvent
  | ClaimEvent;

export function isClaimEvent(event: PipelineEvent): event is ClaimEvent {
  return event.type.startsWith('claim.');
}

// ── Render Service ──────────────────────────────────────────────────────────

export interface RenderJob {
  renderJobId: string;
  claimId: string;
  runId: string | null;
  claimVersion: number;
  idempotencyKey: string;
  status: RenderStatus;
  attempts: number;
  claim: Record<string, unknown>;
  artifactUrl: string | null;
  error: string | null;
  rendererMode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RenderServiceOptions {
  onEvent?: (event: PipelineEvent) => void;
  onJobUpdate?: (job: RenderJob) => void;
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  takumiRenderUrl?: string;
}

// ── Output Package ──────────────────────────────────────────────────────────

export interface OutputPackage {
  packageId: string;
  claimId: string;
  runId: string | null;
  claimVersion: number | null;
  status: PackageStatus;
  error: string | null;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
  payload: TakumiPayload | null;
}

export interface TakumiPayload {
  schemaVersion: string;
  templateVersion: string;
  fields: {
    claim: string;
    correctedClaim: string | null;
    verdict: Verdict;
    confidence: number | null;
    summary: string;
    timecode: string | null;
    sources: {
      publisher: string;
      title: string | null;
      url: string | null;
      textualRating: string | null;
      reviewDate: string | null;
    }[];
    economicEvidence: {
      state: string;
      summary: string | null;
      sources: FredObservation[];
    };
  };
}

// ── Activity Store ──────────────────────────────────────────────────────────

export interface ActivityStoreOptions {
  databaseUrl: string;
  onError?: (error: Error) => void;
}

export interface ActivityStore {
  init: () => Promise<boolean>;
  enqueueEvent: (payload: PipelineEvent) => void;
  enqueueAction: (payload: Record<string, unknown>) => void;
  enqueueRunStart: (payload: Record<string, unknown>) => void;
  enqueueRunStop: (payload: Record<string, unknown>) => void;
  enqueueClaimSnapshot: (payload: Record<string, unknown>) => void;
  enqueueOutputPackage: (payload: Record<string, unknown>) => void;
  enqueueRenderJob: (payload: Record<string, unknown>) => void;
  loadLatestRunClaims: (limit?: number) => Promise<Record<string, unknown>[]>;
  loadRunById: (runId: string) => Promise<Record<string, unknown> | null>;
  listRuns: () => Promise<RunSummary[]>;
  getStatus: () => { configured: boolean; ready: boolean; queueDepth: number; lastError: string | null };
}

// ── Run Summary ─────────────────────────────────────────────────────────────

export interface RunSummary {
  runId: string;
  youtubeUrl: string | null;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  claimCount: number;
}

// ── Database ────────────────────────────────────────────────────────────────

export interface DbQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}
