import { spawn, type ChildProcess } from 'node:child_process';

import type { IngestSource, IngestSourceCallbacks, IngestExitInfo, IngestStatus } from '../types.js';
import { INGEST_SAMPLE_RATE, INGEST_CHANNELS, INGEST_CLOSE_WAIT_MS } from '../constants.js';
import { parsePositiveInt, parseNonNegativeInt } from '../utils.js';

export interface YtdlpSourceOptions {
  youtubeUrl: string;
  callbacks: IngestSourceCallbacks;
  reconnectEnabled?: boolean;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  stallTimeoutMs?: number;
  verboseLogs?: boolean;
}

interface IngestAttempt {
  startedAtMs: number;
  lastAudioByteAtMs: number;
  ytdlp: ChildProcess | null;
  ffmpeg: ChildProcess | null;
  ytdlpExit: { code: number | null; signal: string | null } | null;
  ffmpegExit: { code: number | null; signal: string | null } | null;
  processError: { stage: string; message: string } | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  teardownDone: boolean;
  finalized: boolean;
}

export function createYtdlpSource(options: YtdlpSourceOptions): IngestSource {
  const youtubeUrl = options.youtubeUrl;
  const { onData, onEnd, onLog, onReconnect } = options.callbacks;
  const reconnectEnabled = options.reconnectEnabled ?? true;
  const maxRetries = parseNonNegativeInt(options.maxRetries, 0, 10000);
  const retryBaseMs = parsePositiveInt(options.retryBaseMs, 1000, 120000);
  const retryMaxMs = Math.max(retryBaseMs, parsePositiveInt(options.retryMaxMs, 15000, 600000));
  const stallTimeoutMs = parsePositiveInt(options.stallTimeoutMs, 45000, 300000);
  const verboseLogs = Boolean(options.verboseLogs);

  let running = false;
  let state = 'idle';
  let ytdlpProc: ChildProcess | null = null;
  let ffmpegProc: ChildProcess | null = null;
  let currentAttempt: IngestAttempt | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stallWatchdog: ReturnType<typeof setInterval> | null = null;
  let endEmitted = false;
  let manualStopRequested = false;
  let reconnectSuccessPending = false;
  let lastExitInfo: IngestExitInfo | null = null;
  let lastEventAt: string | null = null;

  function updateLastEvent(): void { lastEventAt = new Date().toISOString(); }
  function isCurrentAttemptFn(attempt: IngestAttempt | null): boolean { return Boolean(attempt && currentAttempt === attempt); }
  function clearReconnectTimer(): void { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
  function clearCloseTimer(attempt: IngestAttempt): void { if (attempt?.closeTimer) { clearTimeout(attempt.closeTimer); attempt.closeTimer = null; } }
  function clearStallWatchdog(): void { if (stallWatchdog) { clearInterval(stallWatchdog); stallWatchdog = null; } }

  function killProcessGracefully(proc: ChildProcess | null): void {
    if (!proc || proc.killed) return;
    try { proc.kill('SIGTERM'); } catch { return; }
    const timeout = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch { /* noop */ } } }, 2000);
    if (typeof timeout.unref === 'function') timeout.unref();
  }

  function teardownAttempt(attempt: IngestAttempt): void {
    if (!attempt || attempt.teardownDone) return;
    attempt.teardownDone = true;
    try { if (attempt.ytdlp?.stdout && attempt.ffmpeg?.stdin) attempt.ytdlp.stdout.unpipe(attempt.ffmpeg.stdin); } catch { /* noop */ }
    try { if (attempt.ffmpeg?.stdin && !attempt.ffmpeg.stdin.destroyed) attempt.ffmpeg.stdin.end(); } catch { /* noop */ }
    killProcessGracefully(attempt.ytdlp);
    killProcessGracefully(attempt.ffmpeg);
  }

  function snapshotLastExit(attempt: IngestAttempt): void {
    lastExitInfo = {
      ytdlpCode: attempt?.ytdlpExit?.code ?? null,
      ytdlpSignal: attempt?.ytdlpExit?.signal ?? null,
      ffmpegCode: attempt?.ffmpegExit?.code ?? null,
      ffmpegSignal: attempt?.ffmpegExit?.signal ?? null,
    };
    updateLastEvent();
  }

  function computeReconnectDelayMs(attemptNo: number): number {
    const exponent = Math.max(0, attemptNo - 1);
    const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** exponent);
    const jitter = Math.floor(Math.random() * Math.min(500, Math.max(80, backoff * 0.2)));
    return Math.max(250, backoff + jitter);
  }

  function classifyAttemptResult(attempt: IngestAttempt, hint: string | null = null): string {
    if (hint === 'process_error' || attempt?.processError) return 'process_error';
    const ytdlpCode = attempt?.ytdlpExit?.code;
    const ffmpegCode = attempt?.ffmpegExit?.code;
    const ytdlpSignal = attempt?.ytdlpExit?.signal;
    const ffmpegSignal = attempt?.ffmpegExit?.signal;
    const hasSignal = Boolean(ytdlpSignal || ffmpegSignal);
    const hasNonZero = [ytdlpCode, ffmpegCode].some((code) => Number.isInteger(code) && code !== 0);
    if (!hasSignal && !hasNonZero && ytdlpCode === 0 && ffmpegCode === 0) return 'source_ended';
    return 'upstream_exit_nonzero';
  }

  function finalizeIngest(reason = 'manual_stop'): void {
    if (endEmitted) return;
    endEmitted = true;
    running = false;
    state = 'stopped';
    clearReconnectTimer();
    clearStallWatchdog();
    if (currentAttempt) teardownAttempt(currentAttempt);
    currentAttempt = null; ytdlpProc = null; ffmpegProc = null;
    onEnd(reason);
  }

  function scheduleReconnect(resultReason: string): void {
    if (!running || manualStopRequested || state === 'stopping' || state === 'stopped') return;
    if (!reconnectEnabled) { finalizeIngest(resultReason === 'source_ended' ? 'source_ended' : 'upstream_exit_nonzero'); return; }
    reconnectAttempt += 1;
    if (maxRetries > 0 && reconnectAttempt > maxRetries) { finalizeIngest('reconnect_exhausted'); return; }
    const delayMs = computeReconnectDelayMs(reconnectAttempt);
    state = 'reconnecting'; reconnectSuccessPending = true;
    onLog('pipeline.reconnect_scheduled', { attempt: reconnectAttempt, delayMs, reason: resultReason, ...lastExitInfo });
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!running || manualStopRequested || state === 'stopping' || state === 'stopped') return;
      onLog('pipeline.reconnect_started', { attempt: reconnectAttempt, reason: resultReason });
      startAttempt();
    }, delayMs);
  }

  function finalizeAttempt(attempt: IngestAttempt, hint: string | null = null): void {
    if (!attempt || attempt.finalized) return;
    attempt.finalized = true;
    clearCloseTimer(attempt);
    if (isCurrentAttemptFn(attempt)) { currentAttempt = null; ytdlpProc = null; ffmpegProc = null; }
    snapshotLastExit(attempt);
    if (!running || manualStopRequested || state === 'stopping' || state === 'stopped') return;
    const resultReason = classifyAttemptResult(attempt, hint);
    scheduleReconnect(resultReason);
  }

  function onProcessClose(attempt: IngestAttempt, stage: string, code: number | null, signal: string | null): void {
    if (!attempt || attempt.finalized) return;
    if (stage === 'yt-dlp') attempt.ytdlpExit = { code, signal };
    else attempt.ffmpegExit = { code, signal };
    onLog('pipeline.log', { stage, message: `${stage} exited with code=${code} signal=${signal}` });
    if (attempt.ytdlpExit && attempt.ffmpegExit) { finalizeAttempt(attempt); return; }
    clearCloseTimer(attempt);
    attempt.closeTimer = setTimeout(() => { finalizeAttempt(attempt); }, INGEST_CLOSE_WAIT_MS);
  }

  function onProcessError(attempt: IngestAttempt, stage: string, error: Error): void {
    if (!attempt || attempt.finalized) return;
    attempt.processError = { stage, message: error.message };
    onLog('pipeline.error', { stage, message: error.message });
    teardownAttempt(attempt);
    finalizeAttempt(attempt, 'process_error');
  }

  function startAttempt(): void {
    if (!running || state === 'stopping' || state === 'stopped') return;
    clearReconnectTimer();
    onReconnect?.();

    const attempt: IngestAttempt = {
      startedAtMs: Date.now(), lastAudioByteAtMs: Date.now(),
      ytdlp: null, ffmpeg: null, ytdlpExit: null, ffmpegExit: null,
      processError: null, closeTimer: null, teardownDone: false, finalized: false,
    };

    const ytdlpArgs = ['-f', 'bestaudio', '--no-live-from-start', '-R', 'infinite', '--fragment-retries', 'infinite', '--extractor-retries', 'infinite', '--retry-sleep', 'http:exp=1:20', '--retry-sleep', 'fragment:exp=1:20', '-o', '-', youtubeUrl];
    if (verboseLogs) { ytdlpArgs.unshift('--newline'); ytdlpArgs.unshift('-v'); }
    else { ytdlpArgs.unshift('--no-progress'); ytdlpArgs.unshift('--no-warnings'); ytdlpArgs.unshift('--quiet'); }

    let nextYtdlpProc: ChildProcess;
    try { nextYtdlpProc = spawn('yt-dlp', ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { onLog('pipeline.error', { stage: 'yt-dlp', message: `Failed to start yt-dlp: ${(error as Error).message}` }); finalizeIngest('process_error'); return; }

    let nextFfmpegProc: ChildProcess;
    try {
      nextFfmpegProc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-fflags', '+discardcorrupt', '-i', 'pipe:0', '-f', 's16le', '-ac', String(INGEST_CHANNELS), '-ar', String(INGEST_SAMPLE_RATE), 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { killProcessGracefully(nextYtdlpProc); onLog('pipeline.error', { stage: 'ffmpeg', message: `Failed to start ffmpeg: ${(error as Error).message}` }); finalizeIngest('process_error'); return; }

    attempt.ytdlp = nextYtdlpProc; attempt.ffmpeg = nextFfmpegProc;
    currentAttempt = attempt; ytdlpProc = nextYtdlpProc; ffmpegProc = nextFfmpegProc;
    state = 'running'; updateLastEvent();

    nextYtdlpProc.stdout!.pipe(nextFfmpegProc.stdin!);
    nextFfmpegProc.stdin!.on('error', () => {}); nextYtdlpProc.stdout!.on('error', () => {}); nextFfmpegProc.stdout!.on('error', () => {}); nextYtdlpProc.stderr!.on('error', () => {}); nextFfmpegProc.stderr!.on('error', () => {});
    nextYtdlpProc.stderr!.on('data', (chunk: Buffer) => { if (!isCurrentAttemptFn(attempt)) return; const message = chunk.toString().trim(); if (message) onLog('pipeline.log', { stage: 'yt-dlp', message }); });
    nextFfmpegProc.stderr!.on('data', (chunk: Buffer) => { if (!isCurrentAttemptFn(attempt)) return; const message = chunk.toString().trim(); if (message) onLog('pipeline.log', { stage: 'ffmpeg', message }); });
    nextYtdlpProc.on('error', (error: Error) => { if (!isCurrentAttemptFn(attempt)) return; onProcessError(attempt, 'yt-dlp', error); });
    nextFfmpegProc.on('error', (error: Error) => { if (!isCurrentAttemptFn(attempt)) return; onProcessError(attempt, 'ffmpeg', error); });
    nextYtdlpProc.on('close', (code: number | null, signal: string | null) => { if (!isCurrentAttemptFn(attempt) && !attempt.finalized) return; onProcessClose(attempt, 'yt-dlp', code, signal); });
    nextFfmpegProc.on('close', (code: number | null, signal: string | null) => { if (!isCurrentAttemptFn(attempt) && !attempt.finalized) return; onProcessClose(attempt, 'ffmpeg', code, signal); });
    nextFfmpegProc.stdout!.on('data', (audioData: Buffer) => {
      if (!isCurrentAttemptFn(attempt) || !running) return;
      attempt.lastAudioByteAtMs = Date.now(); updateLastEvent();
      if (reconnectSuccessPending) { onLog('pipeline.reconnect_succeeded', { attempt: reconnectAttempt }); reconnectSuccessPending = false; reconnectAttempt = 0; }
      onData(audioData);
    });
  }

  function startStallWatchdog(): void {
    clearStallWatchdog();
    stallWatchdog = setInterval(() => {
      if (!running || state !== 'running') return;
      const attempt = currentAttempt;
      if (!attempt || attempt.finalized) return;
      const idleMs = Date.now() - attempt.lastAudioByteAtMs;
      if (idleMs < stallTimeoutMs) return;
      onLog('pipeline.ingest_stalled', { idleMs, thresholdMs: stallTimeoutMs, reconnectAttempt });
      attempt.processError = { stage: 'ingest', message: `No audio bytes received for ${idleMs}ms` };
      teardownAttempt(attempt); finalizeAttempt(attempt, 'process_error');
    }, 2000);
    if (typeof stallWatchdog.unref === 'function') stallWatchdog.unref();
  }

  function start(): void {
    running = true;
    state = 'running';
    endEmitted = false;
    manualStopRequested = false;
    reconnectAttempt = 0;
    reconnectSuccessPending = false;
    lastExitInfo = null;
    updateLastEvent();
    startStallWatchdog();
    startAttempt();
  }

  function stop(reason?: string): void {
    const normalized = String(reason ?? 'manual_stop').trim() || 'manual_stop';
    if (normalized === 'manual_stop' || normalized === 'user_requested_stop') manualStopRequested = true;
    finalizeIngest(normalized);
  }

  function getStatus(): IngestStatus {
    return {
      state,
      reconnectAttempt,
      reconnectEnabled,
      maxRetries,
      lastExitInfo,
      lastEventAt,
    };
  }

  return { start, stop, getStatus };
}
