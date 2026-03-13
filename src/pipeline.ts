import { randomUUID } from 'node:crypto';

import { detectClaims } from './claim-detector.js';
import { lookupFactChecks } from './fact-check-client.js';
import { lookupFredEvidence } from './fred-client.js';
import { lookupCongressEvidence } from './congress-client.js';
import { verifyClaim } from './gemini-verifier.js';
import { pcm16ToWav } from './wav.js';
import { clockTime } from './utils.js';
import { createYtdlpSource } from './ingest/ytdlp-source.js';
import type { PipelineConfig, PipelineInstance, PipelineStatus, PipelineEvent, EvidenceState, GeminiCandidate, IngestSource } from './types.js';
import {
  INGEST_SAMPLE_RATE, INGEST_CHANNELS, INGEST_BYTES_PER_SAMPLE,
  CLAIM_CARRYOVER_MAX_CHARS, CLAIM_FALLBACK_FLUSH_CHARS,
  CLAIM_RECENT_DEDUPE_TTL_MS, CLAIM_RECENT_DEDUPE_MAX,
  TRANSCRIPT_CONTEXT_CHARS, TRANSCRIPT_FLUSH_MAX_CHARS, TRANSCRIPT_FLUSH_TIMEOUT_MS,
  FRED_NOT_APPLICABLE_SUMMARY, CONGRESS_NOT_APPLICABLE_SUMMARY,
} from './constants.js';

const SAMPLE_RATE = INGEST_SAMPLE_RATE;
const CHANNELS = INGEST_CHANNELS;
const BYTES_PER_SAMPLE = INGEST_BYTES_PER_SAMPLE;

function splitCompleteSentencesWithCarryover(text: string): { completeText: string; carryover: string } {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { completeText: '', carryover: '' };

  const sentencePattern = /[^.!?]+[.!?]+(?:["')\]]+)?/g;
  const sentences: string[] = [];
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(normalized)) !== null) {
    const sentence = match[0].trim();
    if (sentence) sentences.push(sentence);
    consumed = sentencePattern.lastIndex;
  }

  return { completeText: sentences.join(' ').trim(), carryover: normalized.slice(consumed).trim() };
}

function stripLeadingOverlap(newText: string, priorTail: string): string {
  if (!priorTail || !newText) return newText;
  const maxCheck = Math.min(priorTail.length, newText.length, TRANSCRIPT_CONTEXT_CHARS);
  for (let len = maxCheck; len >= 10; len--) {
    const suffix = priorTail.slice(-len).toLowerCase().replace(/\s+/g, ' ').trim();
    const prefix = newText.slice(0, len).toLowerCase().replace(/\s+/g, ' ').trim();
    if (suffix === prefix) return newText.slice(len).trim();
  }
  return newText;
}

function correctImplausibleAges(text: string): string {
  if (!text) return text;
  let corrected = text.replace(
    /\b(ages?|aged)\s+(1\d{2})\s+(to|through|and)\s+(1\d{2})\b/gi,
    (match, prefix: string, lo: string, conjunction: string, hi: string) => {
      const loNum = Number(lo) - 100;
      const hiNum = Number(hi) - 100;
      if (loNum >= 0 && loNum <= 99 && hiNum >= 0 && hiNum <= 99 && loNum < hiNum) {
        return `${prefix} ${loNum} ${conjunction} ${hiNum}`;
      }
      return match;
    }
  );
  corrected = corrected.replace(
    /\b(ages?|aged)\s+(over|above|of|beyond)\s+(1\d{2})\b/gi,
    (match, prefix: string, preposition: string, num: string) => {
      const correctedNum = Number(num) - 100;
      if (correctedNum >= 0 && correctedNum <= 99) return `${prefix} ${preposition} ${correctedNum}`;
      return match;
    }
  );
  return corrected;
}

function warnImplausibleAges(text: string, emitFn: (type: string, payload: Record<string, unknown>) => void, chunkIdx: number): void {
  if (!text) return;
  const pattern = /\b(ages?|aged)\s+(\d{3,})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const num = Number(match[2]);
    if (num > 130) {
      emitFn('pipeline.warning', { stage: 'transcription_postprocess', message: `Implausible age reference "${match[0]}" in chunk ${chunkIdx}`, chunkIndex: chunkIdx, value: num });
    }
  }
}

function normalizeClaimKey(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function transcribePcmChunk(pcmChunk: Buffer, options: { apiKey: string; model?: string; signal?: AbortSignal; priorContext?: string; speechContext?: string }): Promise<string> {
  const wav = pcm16ToWav(pcmChunk, { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: 16 });
  const domainContext = options.speechContext ? `This is a live political speech: ${options.speechContext}.` : 'This is a live political speech.';
  const systemText = [
    `You are a precise speech-to-text transcriber. ${domainContext}`,
    'Accuracy rules:',
    '- Human ages almost never exceed 100. If you hear an age that sounds like 140, it is almost certainly 40.',
    '- Prefer plausible numbers when the audio is ambiguous (e.g., billions not trillions for government programs, percentages under 100).',
    '- Transcribe numbers, dollar amounts, and statistics exactly as spoken.',
    '- Output verbatim transcript text only — no commentary, timestamps, or formatting.',
  ].join('\n');

  const turnText = options.priorContext
    ? `Continue transcription. Previous segment ended with: "${options.priorContext}". Do not repeat prior text.`
    : 'Transcribe this audio chunk verbatim.';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model ?? 'gemini-2.5-flash')}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ parts: [{ text: turnText }, { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } }] }],
        generationConfig: { temperature: 0 },
      }),
      signal: options.signal,
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`Gemini transcription failed (${response.status}): ${detail}`);
  }

  interface GeminiResponse { candidates?: GeminiCandidate[]; promptFeedback?: { blockReason?: string } }

  const json = (await response.json()) as GeminiResponse;
  const text = json?.candidates?.flatMap((c) => c?.content?.parts ?? [])?.map((p) => p?.text ?? '')?.join(' ')?.trim();
  if (typeof text !== 'string' || !text) {
    const blockReason = json?.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`Gemini transcription blocked: ${blockReason}`);
    return '';
  }
  return text;
}

export function createPipeline(options: PipelineConfig): PipelineInstance {
  const runId = randomUUID();
  const sourceSpec = options.source;
  const onEvent = options.onEvent;
  const geminiApiKey = options.geminiApiKey;
  const geminiModel = options.geminiModel ?? 'gemini-2.5-flash';
  const geminiVerifyModel = options.geminiVerifyModel ?? 'gemini-2.5-flash';
  const factCheckApiKey = options.factCheckApiKey;
  const fredApiKey = options.fredApiKey;
  const congressApiKey = options.congressApiKey;
  const chunkSeconds = Math.max(5, Math.min(30, options.chunkSeconds ?? 15));
  const maxResearchConcurrency = Math.max(1, Math.min(10, Number(options.maxResearchConcurrency ?? 3)));
  const claimDetectionThreshold = Math.max(0.55, Math.min(0.9, Number(options.claimDetectionThreshold ?? 0.62)));
  const speechContext = options.speechContext ?? '';
  const operatorNotes = options.operatorNotes ?? '';

  const chunkBytes = chunkSeconds * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

  let running = false;
  let bufferedAudio = Buffer.alloc(0);
  let chunkIndex = 0;
  let claimIndex = 0;
  let finalStopEmitted = false;
  let claimSentenceCarryover = '';
  let previousTranscriptTail = '';
  let transcriptAccumulator = '';
  let transcriptAccStartSec: number | null = null;
  let transcriptAccStartClock: string | null = null;
  let transcriptAccEndSec: number | null = null;
  let transcriptAccEndClock: string | null = null;
  let transcriptSegmentIndex = 0;
  let transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const recentClaimKeys = new Map<string, number>();
  const abortController = new AbortController();

  interface TranscriptionQueueItem { pcmChunk: Buffer; chunkIndex: number; startSec: number; endSec: number }
  interface ResearchQueueItem { claimId: string; claim: string; claimCategory?: string; claimTypeTag?: string; claimTypeConfidence?: number; confidence?: number }

  const transcriptionQueue: TranscriptionQueueItem[] = [];
  const researchQueue: ResearchQueueItem[] = [];
  let transcribing = false;
  let researchInFlight = 0;
  let ingestSource: IngestSource | null = null;

  function emit(type: string, payload: Record<string, unknown> = {}): void {
    onEvent?.({ type, runId, at: new Date().toISOString(), ...payload } as PipelineEvent);
  }

  function pruneRecentClaimKeys(nowMs: number): void {
    for (const [key, seenAtMs] of recentClaimKeys) {
      if (nowMs - seenAtMs > CLAIM_RECENT_DEDUPE_TTL_MS) recentClaimKeys.delete(key);
    }
    while (recentClaimKeys.size > CLAIM_RECENT_DEDUPE_MAX) {
      const oldestKey = recentClaimKeys.keys().next().value;
      if (!oldestKey) break;
      recentClaimKeys.delete(oldestKey);
    }
  }

  function markClaimSeenAndCheckDuplicate(claimText: string): boolean {
    const key = normalizeClaimKey(claimText);
    if (!key) return false;
    const nowMs = Date.now();
    pruneRecentClaimKeys(nowMs);
    const seenAt = recentClaimKeys.get(key);
    if (seenAt && nowMs - seenAt < CLAIM_RECENT_DEDUPE_TTL_MS) return true;
    recentClaimKeys.delete(key);
    recentClaimKeys.set(key, nowMs);
    pruneRecentClaimKeys(nowMs);
    return false;
  }

  function claimDetectionTextFromTranscript(transcript: string): string {
    const combined = `${claimSentenceCarryover} ${transcript}`.replace(/\s+/g, ' ').trim();
    if (!combined) return '';
    const { completeText, carryover } = splitCompleteSentencesWithCarryover(combined);
    claimSentenceCarryover = carryover.slice(-CLAIM_CARRYOVER_MAX_CHARS);
    if (completeText) return completeText;
    const carryoverWords = claimSentenceCarryover.split(/\s+/).filter(Boolean).length;
    if (claimSentenceCarryover.length >= CLAIM_FALLBACK_FLUSH_CHARS && carryoverWords >= 15) {
      const flushed = claimSentenceCarryover;
      claimSentenceCarryover = '';
      return flushed;
    }
    return '';
  }

  function flushTranscriptSegment(force: boolean): void {
    if (!transcriptAccumulator) return;
    const { completeText, carryover } = splitCompleteSentencesWithCarryover(transcriptAccumulator);
    const textToEmit = force ? transcriptAccumulator : (completeText || (transcriptAccumulator.length >= TRANSCRIPT_FLUSH_MAX_CHARS ? transcriptAccumulator : ''));
    if (!textToEmit) return;
    const segId = transcriptSegmentIndex++;
    emit('transcript.segment', { segmentId: `${runId}-segment-${segId}`, chunkIndex: segId, startSec: transcriptAccStartSec, endSec: transcriptAccEndSec, startClock: transcriptAccStartClock, endClock: transcriptAccEndClock, text: textToEmit });
    if (force || transcriptAccumulator.length >= TRANSCRIPT_FLUSH_MAX_CHARS) {
      transcriptAccumulator = ''; transcriptAccStartSec = null; transcriptAccStartClock = null; transcriptAccEndSec = null; transcriptAccEndClock = null;
    } else {
      transcriptAccumulator = carryover;
      if (carryover) { transcriptAccStartSec = transcriptAccEndSec; transcriptAccStartClock = transcriptAccEndClock; } else { transcriptAccStartSec = null; transcriptAccStartClock = null; transcriptAccEndSec = null; transcriptAccEndClock = null; }
    }
  }

  function scheduleTranscriptFlush(): void {
    if (transcriptFlushTimer) { clearTimeout(transcriptFlushTimer); transcriptFlushTimer = null; }
    transcriptFlushTimer = setTimeout(() => { transcriptFlushTimer = null; flushTranscriptSegment(false); }, TRANSCRIPT_FLUSH_TIMEOUT_MS);
  }

  function finalizeStop(reason = 'manual_stop'): void {
    if (finalStopEmitted) return;
    finalStopEmitted = true;
    running = false;
    flushTranscriptSegment(true);
    if (transcriptFlushTimer) { clearTimeout(transcriptFlushTimer); transcriptFlushTimer = null; }
    previousTranscriptTail = ''; transcriptAccumulator = '';
    transcriptAccStartSec = null; transcriptAccStartClock = null; transcriptAccEndSec = null; transcriptAccEndClock = null;
    transcriptSegmentIndex = 0;
    abortController.abort();
    bufferedAudio = Buffer.alloc(0);
    transcriptionQueue.length = 0; researchQueue.length = 0;
    claimSentenceCarryover = ''; recentClaimKeys.clear();
    const ingestStatus = ingestSource?.getStatus();
    emit('pipeline.stopped', { reason, reconnectAttempt: ingestStatus?.reconnectAttempt ?? 0, lastIngestExit: ingestStatus?.lastExitInfo ?? null });
  }

  function isAborted(): boolean { return !running || abortController.signal.aborted; }

  function toGoogleEvidenceState(result: { status: string }): string {
    if (result.status === 'researched') return 'matched';
    if (result.status === 'no_match') return 'none';
    return 'error';
  }

  async function researchClaim(claimPayload: ResearchQueueItem): Promise<void> {
    if (isAborted()) return;
    emit('claim.researching', { claimId: claimPayload.claimId, claim: claimPayload.claim });

    try {
      const result = await lookupFactChecks(claimPayload.claim, { apiKey: factCheckApiKey, signal: abortController.signal });
      if (isAborted()) return;

      let status = result.status;
      let fredResult: { state: string; summary: string; sources: unknown[] } = { state: 'not_applicable', summary: FRED_NOT_APPLICABLE_SUMMARY, sources: [] };
      if (claimPayload.claimCategory === 'economic') {
        fredResult = await lookupFredEvidence(claimPayload.claim, { apiKey: fredApiKey, signal: abortController.signal }) as typeof fredResult;
        if (isAborted()) return;
        if (fredResult.state !== 'matched') status = 'needs_manual_research';
      }

      let congressResult: { state: string; summary: string; sources: unknown[] } = { state: 'not_applicable', summary: CONGRESS_NOT_APPLICABLE_SUMMARY, sources: [] };
      if (claimPayload.claimCategory === 'political' || claimPayload.claimCategory === 'legislative') {
        congressResult = await lookupCongressEvidence(claimPayload.claim, { apiKey: congressApiKey, signal: abortController.signal }) as typeof congressResult;
        if (isAborted()) return;
      }

      const aiResult = await verifyClaim(claimPayload.claim, {
        googleFc: { verdict: result.verdict, confidence: result.confidence, summary: result.summary, sources: result.sources },
        fred: { state: fredResult.state as EvidenceState, summary: fredResult.summary, sources: fredResult.sources as [] },
        congress: { state: congressResult.state as EvidenceState, summary: congressResult.summary, sources: congressResult.sources as [] },
        claimCategory: (claimPayload.claimCategory ?? 'general') as 'economic' | 'political' | 'general',
        claimTypeTag: (claimPayload.claimTypeTag ?? 'other') as 'numeric_factual' | 'simple_policy' | 'other',
        currentDate: new Date().toISOString().slice(0, 10),
        speechContext: speechContext || undefined,
        operatorNotes: operatorNotes || undefined,
      }, { apiKey: geminiApiKey, model: geminiVerifyModel, signal: abortController.signal });

      if (isAborted()) return;

      let authoritativeVerdict = 'unverified';
      if (result.verdict !== 'unverified' && result.confidence >= 0.5) authoritativeVerdict = result.verdict;
      else if (fredResult.state === 'matched') authoritativeVerdict = aiResult.aiVerdict;
      else if (congressResult.state === 'matched' && aiResult.aiConfidence >= 0.4) authoritativeVerdict = aiResult.aiVerdict;
      else if (aiResult.evidenceBasis && aiResult.evidenceBasis !== 'general_knowledge' && aiResult.aiConfidence >= 0.5) authoritativeVerdict = aiResult.aiVerdict;

      emit('claim.updated', {
        claimId: claimPayload.claimId, claim: claimPayload.claim, status, verdict: authoritativeVerdict,
        confidence: aiResult.aiConfidence, summary: aiResult.aiSummary, sources: result.sources,
        requiresProducerApproval: true, claimCategory: claimPayload.claimCategory ?? 'general',
        claimTypeTag: claimPayload.claimTypeTag ?? 'other',
        claimTypeConfidence: claimPayload.claimTypeConfidence ?? claimPayload.confidence ?? 0,
        googleEvidenceState: toGoogleEvidenceState(result),
        fredEvidenceState: fredResult.state, fredEvidenceSummary: fredResult.summary, fredEvidenceSources: fredResult.sources,
        congressEvidenceState: congressResult.state, congressEvidenceSummary: congressResult.summary, congressEvidenceSources: congressResult.sources,
        correctedClaim: aiResult.correctedClaim, aiSummary: aiResult.aiSummary, aiVerdict: aiResult.aiVerdict,
        aiConfidence: aiResult.aiConfidence, evidenceBasis: aiResult.evidenceBasis,
        googleFcVerdict: result.verdict, googleFcConfidence: result.confidence, googleFcSummary: result.summary,
      });
    } catch (error) {
      if (isAborted()) return;
      emit('claim.updated', {
        claimId: claimPayload.claimId, claim: claimPayload.claim,
        status: 'needs_manual_research', verdict: 'unverified', confidence: 0,
        summary: `Research pipeline error: ${(error as Error).message}`, sources: [],
        requiresProducerApproval: true, claimCategory: claimPayload.claimCategory ?? 'general',
        claimTypeTag: claimPayload.claimTypeTag ?? 'other',
        claimTypeConfidence: claimPayload.claimTypeConfidence ?? claimPayload.confidence ?? 0,
        googleEvidenceState: 'error',
        fredEvidenceState: claimPayload.claimCategory === 'economic' ? 'error' : 'not_applicable',
        fredEvidenceSummary: claimPayload.claimCategory === 'economic' ? `FRED lookup not completed: ${(error as Error).message}` : FRED_NOT_APPLICABLE_SUMMARY,
        fredEvidenceSources: [],
        congressEvidenceState: (claimPayload.claimCategory === 'political' || claimPayload.claimCategory === 'legislative') ? 'error' : 'not_applicable',
        congressEvidenceSummary: (claimPayload.claimCategory === 'political' || claimPayload.claimCategory === 'legislative') ? `Congress.gov lookup not completed: ${(error as Error).message}` : CONGRESS_NOT_APPLICABLE_SUMMARY,
        congressEvidenceSources: [],
        correctedClaim: null, aiSummary: null, aiVerdict: 'unverified', aiConfidence: 0, evidenceBasis: null,
        googleFcVerdict: null, googleFcConfidence: null, googleFcSummary: null,
      });
    }
  }

  function drainResearchQueue(): void {
    if (!running) return;
    while (researchInFlight < maxResearchConcurrency && researchQueue.length > 0) {
      const next = researchQueue.shift()!;
      researchInFlight += 1;
      void (async () => {
        try { await researchClaim(next); } catch { /* researchClaim handles its own errors */ }
        finally { researchInFlight = Math.max(0, researchInFlight - 1); if (running && researchQueue.length > 0) drainResearchQueue(); }
      })();
    }
  }

  function queueResearchClaim(claimPayload: ResearchQueueItem): void {
    researchQueue.push(claimPayload);
    if (researchQueue.length >= 25 && researchQueue.length % 10 === 0) {
      emit('pipeline.log', { stage: 'research', message: `research queue depth=${researchQueue.length} in_flight=${researchInFlight}` });
    }
    drainResearchQueue();
  }

  async function handleTranscriptionChunk(item: TranscriptionQueueItem): Promise<void> {
    let transcript = '';
    try {
      transcript = await transcribePcmChunk(item.pcmChunk, { apiKey: geminiApiKey, model: geminiModel, signal: abortController.signal, priorContext: previousTranscriptTail || undefined, speechContext: speechContext || undefined });
    } catch (error) {
      if (isAborted()) return;
      emit('transcript.error', { chunkIndex: item.chunkIndex, startSec: item.startSec, endSec: item.endSec, message: (error as Error).message });
      return;
    }
    if (!transcript) return;
    transcript = stripLeadingOverlap(transcript, previousTranscriptTail);
    if (!transcript) return;
    transcript = correctImplausibleAges(transcript);
    warnImplausibleAges(transcript, emit, item.chunkIndex);
    previousTranscriptTail = transcript.slice(-TRANSCRIPT_CONTEXT_CHARS);
    if (transcriptAccStartSec === null) { transcriptAccStartSec = item.startSec; transcriptAccStartClock = clockTime(item.startSec); }
    transcriptAccEndSec = item.endSec; transcriptAccEndClock = clockTime(item.endSec);
    transcriptAccumulator = (transcriptAccumulator + ' ' + transcript).replace(/\s+/g, ' ').trim();
    flushTranscriptSegment(false); scheduleTranscriptFlush();

    try {
      const claimDetectionText = claimDetectionTextFromTranscript(transcript);
      if (!claimDetectionText) return;
      const claims = detectClaims(claimDetectionText, { chunkStartSec: item.startSec, threshold: claimDetectionThreshold });
      for (const detected of claims) {
        if (markClaimSeenAndCheckDuplicate(detected.text)) continue;
        const claimId = `${runId}-claim-${String(++claimIndex).padStart(4, '0')}`;
        const claimPayload = {
          claimId, claim: detected.text, status: 'pending_research', verdict: 'unverified',
          confidence: Number(detected.score.toFixed(2)), reasons: detected.reasons,
          claimCategory: detected.category ?? 'general', claimTypeTag: detected.claimTypeTag ?? 'other',
          claimTypeConfidence: detected.claimTypeConfidence ?? Number(detected.score.toFixed(2)),
          chunkStartSec: detected.chunkStartSec, chunkStartClock: clockTime(detected.chunkStartSec),
        };
        emit('claim.detected', claimPayload);
        queueResearchClaim(claimPayload);
      }
    } catch (claimDetectionError) {
      emit('pipeline.error', { stage: 'claim_detection', message: `Claim detection failed: ${(claimDetectionError as Error).message}` });
    }
  }

  async function drainTranscriptionQueue(): Promise<void> {
    if (transcribing) return;
    transcribing = true;
    try {
      while (running && transcriptionQueue.length > 0) {
        const next = transcriptionQueue.shift()!;
        try { await handleTranscriptionChunk(next); } catch (chunkError) {
          emit('pipeline.error', { stage: 'transcription_chunk', message: `Transcription chunk failed: ${(chunkError as Error).message}` });
        }
      }
    } finally { transcribing = false; }
  }

  function queueChunk(pcmChunk: Buffer, chunkNo: number): void {
    const startSec = chunkNo * chunkSeconds;
    const endSec = startSec + chunkSeconds;
    transcriptionQueue.push({ pcmChunk, chunkIndex: chunkNo, startSec, endSec });
    emit('audio.chunk', { chunkIndex: chunkNo, startSec, endSec, bytes: pcmChunk.length });
    drainTranscriptionQueue().catch((err) => { emit('pipeline.error', { stage: 'transcription_drain', message: `Transcription drain failed: ${(err as Error).message}` }); });
  }

  function handleAudioData(audioData: Buffer): void {
    bufferedAudio = Buffer.concat([bufferedAudio, audioData]);
    while (bufferedAudio.length >= chunkBytes) {
      const pcmChunk = bufferedAudio.subarray(0, chunkBytes);
      bufferedAudio = bufferedAudio.subarray(chunkBytes);
      queueChunk(Buffer.from(pcmChunk), chunkIndex);
      chunkIndex += 1;
    }
  }

  function start(): void {
    if (running) throw new Error('Pipeline is already running');
    if (abortController.signal.aborted) throw new Error('Pipeline cannot be restarted after stop; create a new pipeline instance.');
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is required for transcription');
    running = true; finalStopEmitted = false;
    claimSentenceCarryover = ''; recentClaimKeys.clear(); previousTranscriptTail = '';
    transcriptAccumulator = ''; transcriptAccStartSec = null; transcriptAccStartClock = null;
    transcriptAccEndSec = null; transcriptAccEndClock = null; transcriptSegmentIndex = 0;

    ingestSource = createYtdlpSource({
      youtubeUrl: sourceSpec.url,
      callbacks: {
        onData: handleAudioData,
        onEnd: finalizeStop,
        onLog: (type, payload) => {
          emit(type, payload);
          if (type === 'pipeline.ingest_stalled') {
            if (transcriptionQueue.length > 3 && transcribing) {
              emit('pipeline.warning', { stage: 'transcription_queue', message: `Transcription queue depth=${transcriptionQueue.length} while transcribing=${transcribing}`, queueDepth: transcriptionQueue.length });
            }
            if (transcriptionQueue.length > 10 && transcribing) {
              emit('pipeline.warning', { stage: 'transcription_queue', message: `Force-resetting transcription mutex (queue depth=${transcriptionQueue.length})`, queueDepth: transcriptionQueue.length });
              transcribing = false;
              drainTranscriptionQueue().catch((err) => { emit('pipeline.error', { stage: 'transcription_drain', message: `Transcription drain failed after mutex reset: ${(err as Error).message}` }); });
            }
          }
        },
        onReconnect: () => {
          bufferedAudio = Buffer.alloc(0);
          flushTranscriptSegment(true);
          previousTranscriptTail = '';
        },
      },
      reconnectEnabled: options.ingestReconnectEnabled,
      maxRetries: options.ingestMaxRetries,
      retryBaseMs: options.ingestRetryBaseMs,
      retryMaxMs: options.ingestRetryMaxMs,
      stallTimeoutMs: options.ingestStallTimeoutMs,
      verboseLogs: options.ingestVerboseLogs,
    });

    emit('pipeline.started', { youtubeUrl: sourceSpec.url, chunkSeconds, model: geminiModel, maxResearchConcurrency, claimDetectionThreshold, ingestReconnectEnabled: options.ingestReconnectEnabled ?? true, ingestMaxRetries: options.ingestMaxRetries ?? 0, ingestRetryBaseMs: options.ingestRetryBaseMs ?? 1000, ingestRetryMaxMs: options.ingestRetryMaxMs ?? 15000, ingestStallTimeoutMs: options.ingestStallTimeoutMs ?? 45000 });
    ingestSource.start();
  }

  function stop(reason = 'manual_stop'): void {
    const normalizedReason = String(reason ?? 'manual_stop').trim() || 'manual_stop';
    ingestSource?.stop(normalizedReason);
    finalizeStop(normalizedReason);
  }

  function getStatus(): PipelineStatus {
    const ingest = ingestSource?.getStatus();
    return {
      running,
      ingestState: ingest?.state ?? (running ? 'idle' : 'stopped'),
      reconnectAttempt: ingest?.reconnectAttempt ?? 0,
      reconnectEnabled: ingest?.reconnectEnabled ?? true,
      maxRetries: ingest?.maxRetries ?? 0,
      lastIngestExit: ingest?.lastExitInfo ?? null,
      lastIngestEventAt: ingest?.lastEventAt ?? null,
    };
  }

  return { runId, start, stop, isRunning: () => running, getStatus };
}
