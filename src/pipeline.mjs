import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { detectClaims } from './claimDetector.mjs';
import { lookupFactChecks } from './factCheckClient.mjs';
import { lookupFredEvidence } from './fredClient.mjs';
import { lookupCongressEvidence } from './congressClient.mjs';
import { verifyClaim } from './geminiVerifier.mjs';
import { pcm16ToWav } from './wav.mjs';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CLOSE_WAIT_MS = 1500;
const CLAIM_CARRYOVER_MAX_CHARS = 900;
const CLAIM_FALLBACK_FLUSH_CHARS = 160;
const CLAIM_RECENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const CLAIM_RECENT_DEDUPE_MAX = 1000;
const TRANSCRIPT_CONTEXT_CHARS = 200;
const TRANSCRIPT_FLUSH_MAX_CHARS = 600;
const TRANSCRIPT_FLUSH_TIMEOUT_MS = 4000;

function clockTime(totalSeconds) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((clamped % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (clamped % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function toFinitePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function toNonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function splitCompleteSentencesWithCarryover(text) {
  const normalized = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return {
      completeText: '',
      carryover: ''
    };
  }

  const sentencePattern = /[^.!?]+[.!?]+(?:["')\]]+)?/g;
  const sentences = [];
  let consumed = 0;
  let match;

  while ((match = sentencePattern.exec(normalized)) !== null) {
    const sentence = match[0].trim();
    if (sentence) {
      sentences.push(sentence);
    }
    consumed = sentencePattern.lastIndex;
  }

  return {
    completeText: sentences.join(' ').trim(),
    carryover: normalized.slice(consumed).trim()
  };
}

function stripLeadingOverlap(newText, priorTail) {
  if (!priorTail || !newText) return newText;
  const maxCheck = Math.min(priorTail.length, newText.length, TRANSCRIPT_CONTEXT_CHARS);
  for (let len = maxCheck; len >= 10; len--) {
    const suffix = priorTail.slice(-len).toLowerCase().replace(/\s+/g, ' ').trim();
    const prefix = newText.slice(0, len).toLowerCase().replace(/\s+/g, ' ').trim();
    if (suffix === prefix) {
      return newText.slice(len).trim();
    }
  }
  return newText;
}

function correctImplausibleAges(text) {
  if (!text) return text;

  // Pattern: "age(s|d) NNN to NNN" where both numbers are 100-199 → subtract 100
  let corrected = text.replace(
    /\b(ages?|aged)\s+(1\d{2})\s+(to|through|and)\s+(1\d{2})\b/gi,
    (match, prefix, lo, conjunction, hi) => {
      const loNum = Number(lo) - 100;
      const hiNum = Number(hi) - 100;
      if (loNum >= 0 && loNum <= 99 && hiNum >= 0 && hiNum <= 99 && loNum < hiNum) {
        return `${prefix} ${loNum} ${conjunction} ${hiNum}`;
      }
      return match;
    }
  );

  // Pattern: "age(s) over/above/of NNN" where NNN is 100-199 → subtract 100
  corrected = corrected.replace(
    /\b(ages?|aged)\s+(over|above|of|beyond)\s+(1\d{2})\b/gi,
    (match, prefix, preposition, num) => {
      const correctedNum = Number(num) - 100;
      if (correctedNum >= 0 && correctedNum <= 99) {
        return `${prefix} ${preposition} ${correctedNum}`;
      }
      return match;
    }
  );

  return corrected;
}

function warnImplausibleAges(text, emitFn, chunkIdx) {
  if (!text) return;
  const pattern = /\b(ages?|aged)\s+(\d{3,})\b/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const num = Number(match[2]);
    if (num > 130) {
      emitFn('pipeline.warning', {
        stage: 'transcription_postprocess',
        message: `Implausible age reference "${match[0]}" in chunk ${chunkIdx}`,
        chunkIndex: chunkIdx,
        value: num
      });
    }
  }
}

function normalizeClaimKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function transcribePcmChunk(pcmChunk, options) {
  const wav = pcm16ToWav(pcmChunk, {
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitDepth: 16
  });

  const domainContext = options.speechContext
    ? `This is a live political speech: ${options.speechContext}.`
    : 'This is a live political speech.';

  const systemText = [
    `You are a precise speech-to-text transcriber. ${domainContext}`,
    'Accuracy rules:',
    '- Human ages almost never exceed 100. If you hear an age that sounds like 140, it is almost certainly 40.',
    '- Prefer plausible numbers when the audio is ambiguous (e.g., billions not trillions for government programs, percentages under 100).',
    '- Transcribe numbers, dollar amounts, and statistics exactly as spoken.',
    '- Output verbatim transcript text only — no commentary, timestamps, or formatting.'
  ].join('\n');

  const turnText = options.priorContext
    ? `Continue transcription. Previous segment ended with: "${options.priorContext}". Do not repeat prior text.`
    : 'Transcribe this audio chunk verbatim.';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      options.model ?? 'gemini-2.5-flash'
    )}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': options.apiKey
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemText }]
        },
        contents: [
          {
            parts: [
              { text: turnText },
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: Buffer.from(wav).toString('base64')
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0
        }
      }),
      signal: options.signal
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`Gemini transcription failed (${response.status}): ${detail}`);
  }

  const json = await response.json();
  const text = json?.candidates
    ?.flatMap((candidate) => candidate?.content?.parts ?? [])
    ?.map((part) => part?.text ?? '')
    ?.join(' ')
    ?.trim();

  if (typeof text !== 'string' || !text) {
    const blockReason = json?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini transcription blocked: ${blockReason}`);
    }
    return '';
  }

  return text;
}

export function createPipeline(options) {
  const runId = randomUUID();
  const youtubeUrl = options.youtubeUrl;
  const onEvent = options.onEvent;
  const geminiApiKey = options.geminiApiKey;
  const geminiModel = options.geminiModel ?? 'gemini-2.5-flash';
  const geminiVerifyModel = options.geminiVerifyModel ?? 'gemini-2.5-flash';
  const factCheckApiKey = options.factCheckApiKey;
  const fredApiKey = options.fredApiKey;
  const congressApiKey = options.congressApiKey;
  const chunkSeconds = Math.max(5, Math.min(30, options.chunkSeconds ?? 15));
  const maxResearchConcurrency = Math.max(
    1,
    Math.min(10, Number(options.maxResearchConcurrency ?? 3))
  );
  const ingestReconnectEnabled =
    options.ingestReconnectEnabled === undefined ? true : Boolean(options.ingestReconnectEnabled);
  const ingestMaxRetries = toNonNegativeInt(options.ingestMaxRetries, 0, 10000);
  const ingestRetryBaseMs = toFinitePositiveInt(options.ingestRetryBaseMs, 1000, 120000);
  const ingestRetryMaxMs = Math.max(
    ingestRetryBaseMs,
    toFinitePositiveInt(options.ingestRetryMaxMs, 15000, 600000)
  );
  const ingestStallTimeoutMs = toFinitePositiveInt(options.ingestStallTimeoutMs, 45000, 300000);
  const ingestVerboseLogs = Boolean(options.ingestVerboseLogs);
  const claimDetectionThreshold = Math.max(
    0.55,
    Math.min(0.9, Number(options.claimDetectionThreshold ?? 0.62))
  );
  const speechContext = options.speechContext ?? '';
  const operatorNotes = options.operatorNotes ?? '';

  const chunkBytes = chunkSeconds * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

  let running = false;
  let state = 'idle';
  let ytdlpProc = null;
  let ffmpegProc = null;
  let bufferedAudio = Buffer.alloc(0);
  let chunkIndex = 0;
  let claimIndex = 0;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let stallWatchdog = null;
  let finalStopEmitted = false;
  let manualStopRequested = false;
  let currentAttempt = null;
  let reconnectSuccessPending = false;
  let lastIngestExit = null;
  let lastIngestEventAt = null;
  let claimSentenceCarryover = '';
  let previousTranscriptTail = '';

  // Transcript display accumulator
  let transcriptAccumulator = '';
  let transcriptAccStartSec = null;
  let transcriptAccStartClock = null;
  let transcriptAccEndSec = null;
  let transcriptAccEndClock = null;
  let transcriptSegmentIndex = 0;
  let transcriptFlushTimer = null;

  const recentClaimKeys = new Map();

  const abortController = new AbortController();
  const transcriptionQueue = [];
  const researchQueue = [];
  let transcribing = false;
  let researchInFlight = 0;

  function emit(type, payload = {}) {
    onEvent?.({
      type,
      runId,
      at: new Date().toISOString(),
      ...payload
    });
  }

  function updateLastIngestEvent() {
    lastIngestEventAt = new Date().toISOString();
  }

  function isCurrentAttempt(attempt) {
    return Boolean(attempt && currentAttempt === attempt);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearCloseTimer(attempt) {
    if (attempt?.closeTimer) {
      clearTimeout(attempt.closeTimer);
      attempt.closeTimer = null;
    }
  }

  function clearStallWatchdog() {
    if (stallWatchdog) {
      clearInterval(stallWatchdog);
      stallWatchdog = null;
    }
  }

  function killProcessGracefully(proc) {
    if (!proc || proc.killed) {
      return;
    }

    try {
      proc.kill('SIGTERM');
    } catch {
      return;
    }

    const timeout = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // noop
        }
      }
    }, 2000);

    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }
  }

  function teardownAttempt(attempt) {
    if (!attempt || attempt.teardownDone) {
      return;
    }

    attempt.teardownDone = true;

    try {
      if (attempt.ytdlp?.stdout && attempt.ffmpeg?.stdin) {
        attempt.ytdlp.stdout.unpipe(attempt.ffmpeg.stdin);
      }
    } catch {
      // noop
    }

    try {
      if (attempt.ffmpeg?.stdin && !attempt.ffmpeg.stdin.destroyed) {
        attempt.ffmpeg.stdin.end();
      }
    } catch {
      // noop
    }

    killProcessGracefully(attempt.ytdlp);
    killProcessGracefully(attempt.ffmpeg);
  }

  function snapshotLastExit(attempt) {
    lastIngestExit = {
      ytdlpCode: attempt?.ytdlpExit?.code ?? null,
      ytdlpSignal: attempt?.ytdlpExit?.signal ?? null,
      ffmpegCode: attempt?.ffmpegExit?.code ?? null,
      ffmpegSignal: attempt?.ffmpegExit?.signal ?? null
    };
    updateLastIngestEvent();
  }

  function computeReconnectDelayMs(attemptNo) {
    const exponent = Math.max(0, attemptNo - 1);
    const backoff = Math.min(ingestRetryMaxMs, ingestRetryBaseMs * 2 ** exponent);
    const jitter = Math.floor(Math.random() * Math.min(500, Math.max(80, backoff * 0.2)));
    return Math.max(250, backoff + jitter);
  }

  function pruneRecentClaimKeys(nowMs) {
    for (const [key, seenAtMs] of recentClaimKeys) {
      if (nowMs - seenAtMs > CLAIM_RECENT_DEDUPE_TTL_MS) {
        recentClaimKeys.delete(key);
      }
    }

    while (recentClaimKeys.size > CLAIM_RECENT_DEDUPE_MAX) {
      const oldestKey = recentClaimKeys.keys().next().value;
      if (!oldestKey) {
        break;
      }
      recentClaimKeys.delete(oldestKey);
    }
  }

  function markClaimSeenAndCheckDuplicate(claimText) {
    const key = normalizeClaimKey(claimText);
    if (!key) {
      return false;
    }

    const nowMs = Date.now();
    pruneRecentClaimKeys(nowMs);
    const seenAt = recentClaimKeys.get(key);
    if (seenAt && nowMs - seenAt < CLAIM_RECENT_DEDUPE_TTL_MS) {
      return true;
    }

    recentClaimKeys.delete(key);
    recentClaimKeys.set(key, nowMs);
    pruneRecentClaimKeys(nowMs);
    return false;
  }

  function claimDetectionTextFromTranscript(transcript) {
    const combined = `${claimSentenceCarryover} ${transcript}`.replace(/\s+/g, ' ').trim();
    if (!combined) {
      return '';
    }

    const { completeText, carryover } = splitCompleteSentencesWithCarryover(combined);
    claimSentenceCarryover = carryover.slice(-CLAIM_CARRYOVER_MAX_CHARS);

    if (completeText) {
      return completeText;
    }

    // Safety valve for transcript outputs that omit punctuation for long stretches.
    const carryoverWords = claimSentenceCarryover.split(/\s+/).filter(Boolean).length;
    if (
      claimSentenceCarryover.length >= CLAIM_FALLBACK_FLUSH_CHARS &&
      carryoverWords >= 15
    ) {
      const flushed = claimSentenceCarryover;
      claimSentenceCarryover = '';
      return flushed;
    }

    return '';
  }

  function flushTranscriptSegment(force) {
    if (!transcriptAccumulator) return;

    const { completeText, carryover } = splitCompleteSentencesWithCarryover(transcriptAccumulator);
    const textToEmit = force
      ? transcriptAccumulator
      : (completeText || (transcriptAccumulator.length >= TRANSCRIPT_FLUSH_MAX_CHARS ? transcriptAccumulator : ''));

    if (!textToEmit) return;

    const segId = transcriptSegmentIndex++;
    emit('transcript.segment', {
      segmentId: `${runId}-segment-${segId}`,
      chunkIndex: segId,
      startSec: transcriptAccStartSec,
      endSec: transcriptAccEndSec,
      startClock: transcriptAccStartClock,
      endClock: transcriptAccEndClock,
      text: textToEmit
    });

    if (force || transcriptAccumulator.length >= TRANSCRIPT_FLUSH_MAX_CHARS) {
      transcriptAccumulator = '';
      transcriptAccStartSec = null;
      transcriptAccStartClock = null;
      transcriptAccEndSec = null;
      transcriptAccEndClock = null;
    } else {
      transcriptAccumulator = carryover;
      if (carryover) {
        // Keep the start time anchored to the remaining carryover's chunk
        // (endSec of the flushed segment becomes the start for next)
        transcriptAccStartSec = transcriptAccEndSec;
        transcriptAccStartClock = transcriptAccEndClock;
      } else {
        transcriptAccStartSec = null;
        transcriptAccStartClock = null;
        transcriptAccEndSec = null;
        transcriptAccEndClock = null;
      }
    }
  }

  function scheduleTranscriptFlush() {
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
    }
    transcriptFlushTimer = setTimeout(() => {
      transcriptFlushTimer = null;
      flushTranscriptSegment(false);
    }, TRANSCRIPT_FLUSH_TIMEOUT_MS);
  }

  function classifyAttemptResult(attempt, hint = null) {
    if (hint === 'process_error' || attempt?.processError) {
      return 'process_error';
    }

    const ytdlpCode = attempt?.ytdlpExit?.code;
    const ffmpegCode = attempt?.ffmpegExit?.code;
    const ytdlpSignal = attempt?.ytdlpExit?.signal;
    const ffmpegSignal = attempt?.ffmpegExit?.signal;
    const hasSignal = Boolean(ytdlpSignal || ffmpegSignal);
    const hasNonZero = [ytdlpCode, ffmpegCode].some(
      (code) => Number.isInteger(code) && code !== 0
    );

    if (!hasSignal && !hasNonZero && ytdlpCode === 0 && ffmpegCode === 0) {
      return 'source_ended';
    }

    return 'upstream_exit_nonzero';
  }

  function finalizeStop(reason = 'manual_stop') {
    if (finalStopEmitted) {
      return;
    }

    finalStopEmitted = true;
    running = false;
    state = 'stopping';

    // Flush remaining accumulated transcript text before teardown
    flushTranscriptSegment(true);
    if (transcriptFlushTimer) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
    }
    previousTranscriptTail = '';
    transcriptAccumulator = '';
    transcriptAccStartSec = null;
    transcriptAccStartClock = null;
    transcriptAccEndSec = null;
    transcriptAccEndClock = null;
    transcriptSegmentIndex = 0;

    clearReconnectTimer();
    clearStallWatchdog();

    abortController.abort();

    if (currentAttempt) {
      teardownAttempt(currentAttempt);
    }

    currentAttempt = null;
    ytdlpProc = null;
    ffmpegProc = null;

    bufferedAudio = Buffer.alloc(0);
    transcriptionQueue.length = 0;
    researchQueue.length = 0;
    claimSentenceCarryover = '';
    recentClaimKeys.clear();

    state = 'stopped';

    emit('pipeline.stopped', {
      reason,
      reconnectAttempt,
      lastIngestExit
    });
  }

  function scheduleReconnect(resultReason, attempt) {
    if (!running || manualStopRequested || state === 'stopping' || state === 'stopped') {
      return;
    }

    if (!ingestReconnectEnabled) {
      finalizeStop(resultReason === 'source_ended' ? 'source_ended' : 'upstream_exit_nonzero');
      return;
    }

    reconnectAttempt += 1;

    if (ingestMaxRetries > 0 && reconnectAttempt > ingestMaxRetries) {
      finalizeStop('reconnect_exhausted');
      return;
    }

    const delayMs = computeReconnectDelayMs(reconnectAttempt);
    state = 'reconnecting';
    reconnectSuccessPending = true;

    emit('pipeline.reconnect_scheduled', {
      attempt: reconnectAttempt,
      delayMs,
      reason: resultReason,
      ...lastIngestExit
    });

    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!running || manualStopRequested || state === 'stopping' || state === 'stopped') {
        return;
      }

      emit('pipeline.reconnect_started', {
        attempt: reconnectAttempt,
        reason: resultReason
      });

      startIngestAttempt();
    }, delayMs);
  }

  function finalizeAttempt(attempt, hint = null) {
    if (!attempt || attempt.finalized) {
      return;
    }

    attempt.finalized = true;
    clearCloseTimer(attempt);

    if (isCurrentAttempt(attempt)) {
      currentAttempt = null;
      ytdlpProc = null;
      ffmpegProc = null;
    }

    snapshotLastExit(attempt);

    if (!running || manualStopRequested || state === 'stopping' || state === 'stopped') {
      return;
    }

    const resultReason = classifyAttemptResult(attempt, hint);
    scheduleReconnect(resultReason, attempt);
  }

  function onProcessClose(attempt, stage, code, signal) {
    if (!attempt || attempt.finalized) {
      return;
    }

    if (stage === 'yt-dlp') {
      attempt.ytdlpExit = { code, signal };
    } else {
      attempt.ffmpegExit = { code, signal };
    }

    emit('pipeline.log', {
      stage,
      message: `${stage} exited with code=${code} signal=${signal}`
    });

    if (attempt.ytdlpExit && attempt.ffmpegExit) {
      finalizeAttempt(attempt);
      return;
    }

    clearCloseTimer(attempt);
    attempt.closeTimer = setTimeout(() => {
      finalizeAttempt(attempt);
    }, CLOSE_WAIT_MS);
  }

  function onProcessError(attempt, stage, error) {
    if (!attempt || attempt.finalized) {
      return;
    }

    attempt.processError = {
      stage,
      message: error.message
    };

    emit('pipeline.error', {
      stage,
      message: error.message
    });

    teardownAttempt(attempt);
    finalizeAttempt(attempt, 'process_error');
  }

  function startIngestAttempt() {
    if (!running || state === 'stopping' || state === 'stopped') {
      return;
    }

    clearReconnectTimer();
    bufferedAudio = Buffer.alloc(0);

    // Flush stale pre-reconnect transcript and reset context
    flushTranscriptSegment(true);
    previousTranscriptTail = '';

    const attempt = {
      startedAtMs: Date.now(),
      lastAudioByteAtMs: Date.now(),
      ytdlp: null,
      ffmpeg: null,
      ytdlpExit: null,
      ffmpegExit: null,
      processError: null,
      closeTimer: null,
      teardownDone: false,
      finalized: false
    };

    const ytdlpArgs = [
      '-f',
      'bestaudio',
      '--no-live-from-start',
      '-R',
      'infinite',
      '--fragment-retries',
      'infinite',
      '--extractor-retries',
      'infinite',
      '--retry-sleep',
      'http:exp=1:20',
      '--retry-sleep',
      'fragment:exp=1:20',
      '-o',
      '-',
      youtubeUrl
    ];

    if (ingestVerboseLogs) {
      ytdlpArgs.unshift('--newline');
      ytdlpArgs.unshift('-v');
    } else {
      ytdlpArgs.unshift('--no-progress');
      ytdlpArgs.unshift('--no-warnings');
      ytdlpArgs.unshift('--quiet');
    }

    let nextYtdlpProc;
    try {
      nextYtdlpProc = spawn('yt-dlp', ytdlpArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      emit('pipeline.error', {
        stage: 'yt-dlp',
        message: `Failed to start yt-dlp: ${error.message}`
      });
      finalizeStop('process_error');
      return;
    }

    let nextFfmpegProc;
    try {
      nextFfmpegProc = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-fflags',
          '+discardcorrupt',
          '-i',
          'pipe:0',
          '-f',
          's16le',
          '-ac',
          String(CHANNELS),
          '-ar',
          String(SAMPLE_RATE),
          'pipe:1'
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
    } catch (error) {
      killProcessGracefully(nextYtdlpProc);
      emit('pipeline.error', {
        stage: 'ffmpeg',
        message: `Failed to start ffmpeg: ${error.message}`
      });
      finalizeStop('process_error');
      return;
    }

    attempt.ytdlp = nextYtdlpProc;
    attempt.ffmpeg = nextFfmpegProc;
    currentAttempt = attempt;
    ytdlpProc = nextYtdlpProc;
    ffmpegProc = nextFfmpegProc;
    state = 'running';
    updateLastIngestEvent();

    nextYtdlpProc.stdout.pipe(nextFfmpegProc.stdin);

    // Absorb EPIPE / read errors on subprocess stdio during teardown.
    // Retry/stop decisions are handled by 'close' and process-level 'error' handlers.
    nextFfmpegProc.stdin.on('error', () => {});   // EPIPE when ffmpeg killed
    nextYtdlpProc.stdout.on('error', () => {});   // read error when yt-dlp killed
    nextFfmpegProc.stdout.on('error', () => {});  // read error when ffmpeg killed
    nextYtdlpProc.stderr.on('error', () => {});   // read error when yt-dlp killed
    nextFfmpegProc.stderr.on('error', () => {});  // read error when ffmpeg killed

    nextYtdlpProc.stderr.on('data', (chunk) => {
      if (!isCurrentAttempt(attempt)) {
        return;
      }

      const message = chunk.toString().trim();
      if (message) {
        emit('pipeline.log', {
          stage: 'yt-dlp',
          message
        });
      }
    });

    nextFfmpegProc.stderr.on('data', (chunk) => {
      if (!isCurrentAttempt(attempt)) {
        return;
      }

      const message = chunk.toString().trim();
      if (message) {
        emit('pipeline.log', {
          stage: 'ffmpeg',
          message
        });
      }
    });

    nextYtdlpProc.on('error', (error) => {
      if (!isCurrentAttempt(attempt)) {
        return;
      }
      onProcessError(attempt, 'yt-dlp', error);
    });

    nextFfmpegProc.on('error', (error) => {
      if (!isCurrentAttempt(attempt)) {
        return;
      }
      onProcessError(attempt, 'ffmpeg', error);
    });

    nextYtdlpProc.on('close', (code, signal) => {
      if (!isCurrentAttempt(attempt) && !attempt.finalized) {
        return;
      }
      onProcessClose(attempt, 'yt-dlp', code, signal);
    });

    nextFfmpegProc.on('close', (code, signal) => {
      if (!isCurrentAttempt(attempt) && !attempt.finalized) {
        return;
      }
      onProcessClose(attempt, 'ffmpeg', code, signal);
    });

    nextFfmpegProc.stdout.on('data', (audioData) => {
      if (!isCurrentAttempt(attempt) || !running) {
        return;
      }

      attempt.lastAudioByteAtMs = Date.now();
      updateLastIngestEvent();

      if (reconnectSuccessPending) {
        emit('pipeline.reconnect_succeeded', {
          attempt: reconnectAttempt
        });
        reconnectSuccessPending = false;
        reconnectAttempt = 0;
      }

      handleAudioData(audioData);
    });
  }

  function startStallWatchdog() {
    clearStallWatchdog();

    stallWatchdog = setInterval(() => {
      if (!running || state !== 'running') {
        return;
      }

      const attempt = currentAttempt;
      if (!attempt || attempt.finalized) {
        return;
      }

      const idleMs = Date.now() - attempt.lastAudioByteAtMs;
      if (idleMs < ingestStallTimeoutMs) {
        return;
      }

      emit('pipeline.ingest_stalled', {
        idleMs,
        thresholdMs: ingestStallTimeoutMs,
        reconnectAttempt
      });

      attempt.processError = {
        stage: 'ingest',
        message: `No audio bytes received for ${idleMs}ms`
      };

      teardownAttempt(attempt);
      finalizeAttempt(attempt, 'process_error');

      // Transcription queue depth monitoring
      if (transcriptionQueue.length > 3 && transcribing) {
        emit('pipeline.warning', {
          stage: 'transcription_queue',
          message: `Transcription queue depth=${transcriptionQueue.length} while transcribing=${transcribing}`,
          queueDepth: transcriptionQueue.length
        });
      }
      if (transcriptionQueue.length > 10 && transcribing) {
        emit('pipeline.warning', {
          stage: 'transcription_queue',
          message: `Force-resetting transcription mutex (queue depth=${transcriptionQueue.length})`,
          queueDepth: transcriptionQueue.length
        });
        transcribing = false;
        drainTranscriptionQueue().catch((err) => {
          emit('pipeline.error', {
            stage: 'transcription_drain',
            message: `Transcription drain failed after mutex reset: ${err.message}`
          });
        });
      }
    }, 2000);

    if (typeof stallWatchdog.unref === 'function') {
      stallWatchdog.unref();
    }
  }

  function isAborted() {
    return !running || abortController.signal.aborted;
  }

  function toGoogleEvidenceState(result) {
    if (result.status === 'researched') {
      return 'matched';
    }

    if (result.status === 'no_match') {
      return 'none';
    }

    return 'error';
  }

  async function researchClaim(claimPayload) {
    if (isAborted()) {
      return;
    }

    emit('claim.researching', {
      claimId: claimPayload.claimId,
      claim: claimPayload.claim
    });

    try {
      const result = await lookupFactChecks(claimPayload.claim, {
        apiKey: factCheckApiKey,
        signal: abortController.signal
      });

      if (isAborted()) {
        return;
      }

      let status = result.status;
      let fredResult = {
        state: 'not_applicable',
        summary: 'No economic indicator mapping required for this claim.',
        sources: []
      };

      if (claimPayload.claimCategory === 'economic') {
        fredResult = await lookupFredEvidence(claimPayload.claim, {
          apiKey: fredApiKey,
          signal: abortController.signal
        });

        if (isAborted()) {
          return;
        }

        if (fredResult.state !== 'matched') {
          status = 'needs_manual_research';
        }
      }

      let congressResult = {
        state: 'not_applicable',
        summary: 'No legislative evidence lookup required for this claim.',
        sources: []
      };

      if (claimPayload.claimCategory === 'political' || claimPayload.claimCategory === 'legislative') {
        congressResult = await lookupCongressEvidence(claimPayload.claim, {
          apiKey: congressApiKey,
          signal: abortController.signal
        });

        if (isAborted()) {
          return;
        }
      }

      const aiResult = await verifyClaim(
        claimPayload.claim,
        {
          googleFc: {
            verdict: result.verdict,
            confidence: result.confidence,
            summary: result.summary,
            sources: result.sources
          },
          fred: {
            state: fredResult.state,
            summary: fredResult.summary,
            sources: fredResult.sources
          },
          congress: {
            state: congressResult.state,
            summary: congressResult.summary,
            sources: congressResult.sources
          },
          claimCategory: claimPayload.claimCategory ?? 'general',
          claimTypeTag: claimPayload.claimTypeTag ?? 'other',
          currentDate: new Date().toISOString().slice(0, 10),
          speechContext: speechContext || undefined,
          operatorNotes: operatorNotes || undefined
        },
        {
          apiKey: geminiApiKey,
          model: geminiVerifyModel,
          signal: abortController.signal
        }
      );

      if (isAborted()) {
        return;
      }

      // Determine authoritative verdict for graphics
      // Priority: high-confidence Google FC verdict > FRED-backed AI verdict > evidence-backed AI verdict > 'unverified'
      let authoritativeVerdict = 'unverified';
      if (result.verdict !== 'unverified' && result.confidence >= 0.5) {
        // Google FC with sufficient confidence
        authoritativeVerdict = result.verdict;
      } else if (fredResult.state === 'matched') {
        // FRED data provides authoritative economic evidence
        authoritativeVerdict = aiResult.aiVerdict;
      } else if (congressResult.state === 'matched' && aiResult.aiConfidence >= 0.4) {
        // Congress data provides authoritative legislative evidence
        authoritativeVerdict = aiResult.aiVerdict;
      } else if (aiResult.evidenceBasis && aiResult.evidenceBasis !== 'general_knowledge' && aiResult.aiConfidence >= 0.5) {
        // AI verdict backed by external evidence
        authoritativeVerdict = aiResult.aiVerdict;
      }

      emit('claim.updated', {
        claimId: claimPayload.claimId,
        claim: claimPayload.claim,
        status,
        verdict: authoritativeVerdict,
        confidence: aiResult.aiConfidence,
        summary: aiResult.aiSummary,
        sources: result.sources,
        requiresProducerApproval: true,
        claimCategory: claimPayload.claimCategory ?? 'general',
        claimTypeTag: claimPayload.claimTypeTag ?? 'other',
        claimTypeConfidence: claimPayload.claimTypeConfidence ?? claimPayload.confidence ?? 0,
        googleEvidenceState: toGoogleEvidenceState(result),
        fredEvidenceState: fredResult.state,
        fredEvidenceSummary: fredResult.summary,
        fredEvidenceSources: fredResult.sources,
        congressEvidenceState: congressResult.state,
        congressEvidenceSummary: congressResult.summary,
        congressEvidenceSources: congressResult.sources,
        correctedClaim: aiResult.correctedClaim,
        aiSummary: aiResult.aiSummary,
        aiVerdict: aiResult.aiVerdict,
        aiConfidence: aiResult.aiConfidence,
        evidenceBasis: aiResult.evidenceBasis,
        googleFcVerdict: result.verdict,
        googleFcConfidence: result.confidence,
        googleFcSummary: result.summary
      });
    } catch (error) {
      if (isAborted()) {
        return;
      }

      emit('claim.updated', {
        claimId: claimPayload.claimId,
        claim: claimPayload.claim,
        status: 'needs_manual_research',
        verdict: 'unverified',
        confidence: 0,
        summary: `Research pipeline error: ${error.message}`,
        sources: [],
        requiresProducerApproval: true,
        claimCategory: claimPayload.claimCategory ?? 'general',
        claimTypeTag: claimPayload.claimTypeTag ?? 'other',
        claimTypeConfidence: claimPayload.claimTypeConfidence ?? claimPayload.confidence ?? 0,
        googleEvidenceState: 'error',
        fredEvidenceState:
          claimPayload.claimCategory === 'economic' ? 'error' : 'not_applicable',
        fredEvidenceSummary:
          claimPayload.claimCategory === 'economic'
            ? `FRED lookup not completed: ${error.message}`
            : 'No economic indicator mapping required for this claim.',
        fredEvidenceSources: [],
        congressEvidenceState:
          (claimPayload.claimCategory === 'political' || claimPayload.claimCategory === 'legislative') ? 'error' : 'not_applicable',
        congressEvidenceSummary:
          (claimPayload.claimCategory === 'political' || claimPayload.claimCategory === 'legislative')
            ? `Congress.gov lookup not completed: ${error.message}`
            : 'No legislative evidence lookup required for this claim.',
        congressEvidenceSources: [],
        correctedClaim: null,
        aiSummary: null,
        aiVerdict: 'unverified',
        aiConfidence: 0,
        evidenceBasis: null,
        googleFcVerdict: null,
        googleFcConfidence: null,
        googleFcSummary: null
      });
    }
  }

  function drainResearchQueue() {
    if (!running) {
      return;
    }

    while (researchInFlight < maxResearchConcurrency && researchQueue.length > 0) {
      const next = researchQueue.shift();
      researchInFlight += 1;

      void (async () => {
        try {
          await researchClaim(next);
        } catch {
          // researchClaim handles its own errors; this catch prevents
          // unhandled rejection if emit() throws during error-path broadcasting
        } finally {
          researchInFlight = Math.max(0, researchInFlight - 1);
          if (running && researchQueue.length > 0) {
            drainResearchQueue();
          }
        }
      })();
    }
  }

  function queueResearchClaim(claimPayload) {
    researchQueue.push(claimPayload);
    if (researchQueue.length >= 25 && researchQueue.length % 10 === 0) {
      emit('pipeline.log', {
        stage: 'research',
        message: `research queue depth=${researchQueue.length} in_flight=${researchInFlight}`
      });
    }
    drainResearchQueue();
  }

  async function handleTranscriptionChunk(item) {
    let transcript = '';
    try {
      transcript = await transcribePcmChunk(item.pcmChunk, {
        apiKey: geminiApiKey,
        model: geminiModel,
        signal: abortController.signal,
        priorContext: previousTranscriptTail || undefined,
        speechContext: speechContext || undefined
      });
    } catch (error) {
      if (isAborted()) {
        return;
      }

      emit('transcript.error', {
        chunkIndex: item.chunkIndex,
        startSec: item.startSec,
        endSec: item.endSec,
        message: error.message
      });
      return;
    }

    if (!transcript) {
      return;
    }

    // Strip echoed overlap if Gemini repeated the context
    transcript = stripLeadingOverlap(transcript, previousTranscriptTail);
    if (!transcript) {
      return;
    }

    // Fix hundred-inflated ages (e.g., "ages 140 to 149" → "ages 40 to 49")
    transcript = correctImplausibleAges(transcript);
    warnImplausibleAges(transcript, emit, item.chunkIndex);

    // Update rolling context tail for next chunk
    previousTranscriptTail = transcript.slice(-TRANSCRIPT_CONTEXT_CHARS);

    // Accumulate for sentence-boundary flushing instead of emitting directly
    if (transcriptAccStartSec === null) {
      transcriptAccStartSec = item.startSec;
      transcriptAccStartClock = clockTime(item.startSec);
    }
    transcriptAccEndSec = item.endSec;
    transcriptAccEndClock = clockTime(item.endSec);
    transcriptAccumulator = (transcriptAccumulator + ' ' + transcript).replace(/\s+/g, ' ').trim();
    flushTranscriptSegment(false);
    scheduleTranscriptFlush();

    // Claim detection still operates on per-chunk transcript
    try {
      const claimDetectionText = claimDetectionTextFromTranscript(transcript);
      if (!claimDetectionText) {
        return;
      }

      const claims = detectClaims(claimDetectionText, {
        chunkStartSec: item.startSec,
        threshold: claimDetectionThreshold
      });

      for (const detected of claims) {
        if (markClaimSeenAndCheckDuplicate(detected.text)) {
          continue;
        }

        const claimId = `${runId}-claim-${String(++claimIndex).padStart(4, '0')}`;
        const claimPayload = {
          claimId,
          claim: detected.text,
          status: 'pending_research',
          verdict: 'unverified',
          confidence: Number(detected.score.toFixed(2)),
          reasons: detected.reasons,
          claimCategory: detected.category ?? 'general',
          claimTypeTag: detected.claimTypeTag ?? 'other',
          claimTypeConfidence: detected.claimTypeConfidence ?? Number(detected.score.toFixed(2)),
          chunkStartSec: detected.chunkStartSec,
          chunkStartClock: clockTime(detected.chunkStartSec)
        };

        emit('claim.detected', claimPayload);
        queueResearchClaim(claimPayload);
      }
    } catch (claimDetectionError) {
      emit('pipeline.error', {
        stage: 'claim_detection',
        message: `Claim detection failed: ${claimDetectionError.message}`
      });
    }
  }

  async function drainTranscriptionQueue() {
    if (transcribing) {
      return;
    }

    transcribing = true;
    try {
      while (running && transcriptionQueue.length > 0) {
        const next = transcriptionQueue.shift();
        try {
          await handleTranscriptionChunk(next);
        } catch (chunkError) {
          emit('pipeline.error', {
            stage: 'transcription_chunk',
            message: `Transcription chunk failed: ${chunkError.message}`
          });
        }
      }
    } finally {
      transcribing = false;
    }
  }

  function queueChunk(pcmChunk, chunkNo) {
    const startSec = chunkNo * chunkSeconds;
    const endSec = startSec + chunkSeconds;

    transcriptionQueue.push({
      pcmChunk,
      chunkIndex: chunkNo,
      startSec,
      endSec
    });

    emit('audio.chunk', {
      chunkIndex: chunkNo,
      startSec,
      endSec,
      bytes: pcmChunk.length
    });

    drainTranscriptionQueue().catch((err) => {
      emit('pipeline.error', {
        stage: 'transcription_drain',
        message: `Transcription drain failed: ${err.message}`
      });
    });
  }

  function handleAudioData(audioData) {
    bufferedAudio = Buffer.concat([bufferedAudio, audioData]);

    while (bufferedAudio.length >= chunkBytes) {
      const pcmChunk = bufferedAudio.subarray(0, chunkBytes);
      bufferedAudio = bufferedAudio.subarray(chunkBytes);
      queueChunk(Buffer.from(pcmChunk), chunkIndex);
      chunkIndex += 1;
    }
  }

  function start() {
    if (running) {
      throw new Error('Pipeline is already running');
    }

    if (abortController.signal.aborted) {
      throw new Error('Pipeline cannot be restarted after stop; create a new pipeline instance.');
    }

    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required for transcription');
    }

    running = true;
    state = 'running';
    finalStopEmitted = false;
    manualStopRequested = false;
    reconnectAttempt = 0;
    reconnectSuccessPending = false;
    lastIngestExit = null;
    updateLastIngestEvent();
    claimSentenceCarryover = '';
    recentClaimKeys.clear();
    previousTranscriptTail = '';
    transcriptAccumulator = '';
    transcriptAccStartSec = null;
    transcriptAccStartClock = null;
    transcriptAccEndSec = null;
    transcriptAccEndClock = null;
    transcriptSegmentIndex = 0;

    emit('pipeline.started', {
      youtubeUrl,
      chunkSeconds,
      model: geminiModel,
      maxResearchConcurrency,
      claimDetectionThreshold,
      ingestReconnectEnabled,
      ingestMaxRetries,
      ingestRetryBaseMs,
      ingestRetryMaxMs,
      ingestStallTimeoutMs
    });

    startStallWatchdog();
    startIngestAttempt();
  }

  function stop(reason = 'manual_stop') {
    const normalizedReason = String(reason ?? 'manual_stop').trim() || 'manual_stop';
    if (normalizedReason === 'manual_stop' || normalizedReason === 'user_requested_stop') {
      manualStopRequested = true;
    }

    finalizeStop(normalizedReason);
  }

  function getStatus() {
    return {
      running,
      ingestState: running ? state : 'stopped',
      reconnectAttempt,
      reconnectEnabled: ingestReconnectEnabled,
      maxRetries: ingestMaxRetries,
      lastIngestExit,
      lastIngestEventAt
    };
  }

  return {
    runId,
    start,
    stop,
    isRunning: () => running,
    getStatus
  };
}
