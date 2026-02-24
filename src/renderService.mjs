import { randomUUID } from 'node:crypto';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localFallbackSvgArtifact(claim) {
  const verdict = String(claim.verdict ?? 'unverified').toLowerCase();
  const claimText = String(claim.claim ?? '').slice(0, 484);
  const correctedClaim = claim.correctedClaim ? String(claim.correctedClaim).slice(0, 484) : null;
  const escaped = (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Verdict badge colors
  const verdictColors = {
    true: { bg: '#166534', text: '#4ade80', label: 'TRUE' },
    false: { bg: '#991b1b', text: '#f87171', label: 'FALSE' },
    misleading: { bg: '#92400e', text: '#fbbf24', label: 'MISLEADING' },
    verified: { bg: '#166534', text: '#4ade80', label: 'VERIFIED' },
    unverified: { bg: '#c2410c', text: '#fb923c', label: 'UNSUPPORTED' }
  };
  const vc = verdictColors[verdict] || verdictColors.unverified;

  // Wrap text into lines (approx 56 chars per line at font-size 26)
  function wrapText(str, maxChars) {
    const words = str.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current && (current.length + 1 + word.length) > maxChars) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) lines.push(current);
    return lines.slice(0, 4); // max 4 lines
  }

  const claimLines = wrapText(claimText, 56);
  const claimTextSvg = claimLines.map((line, i) =>
    `<text x="96" y="${346 + i * 32}" fill="#e2e8f0" font-family="Arial, sans-serif" font-size="24">${escaped(line)}</text>`
  ).join('\n  ');

  const claimCardHeight = 80 + claimLines.length * 32;

  let actualCardSvg = '';
  if (correctedClaim && verdict !== 'true') {
    const actualLines = wrapText(correctedClaim, 56);
    const actualY = 270 + claimCardHeight + 20;
    const actualCardHeight = 80 + actualLines.length * 32;
    const actualTextSvg = actualLines.map((line, i) =>
      `<text x="96" y="${actualY + 60 + i * 32}" fill="#e2e8f0" font-family="Arial, sans-serif" font-size="24">${escaped(line)}</text>`
    ).join('\n  ');

    actualCardSvg = `
  <rect x="44" y="${actualY}" width="1192" height="${actualCardHeight}" fill="#1e293b" rx="12"/>
  <rect x="44" y="${actualY}" width="4" height="${actualCardHeight}" fill="#22c55e" rx="2"/>
  <text x="96" y="${actualY + 32}" fill="#94a3b8" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="0.08em">ACTUAL</text>
  ${actualTextSvg}`;
  }

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="44" y="50" fill="#e2e8f0" font-family="Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="0.1em">FACT CHECKER</text>
  <rect x="220" y="32" width="52" height="24" fill="#334155" rx="4"/>
  <text x="246" y="50" fill="#94a3b8" font-family="Arial, sans-serif" font-size="12" font-weight="600" text-anchor="middle">BETA</text>
  <text x="44" y="76" fill="#64748b" font-family="Arial, sans-serif" font-size="13">POWERED BY GOOGLE FACT CHECK API</text>
  <rect x="44" y="100" width="1192" height="2" fill="#1e293b"/>
  <rect x="44" y="270" width="1192" height="${claimCardHeight}" fill="#1e293b" rx="12"/>
  <text x="96" y="302" fill="#94a3b8" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="0.08em">CLAIM</text>
  <rect x="180" y="286" width="${vc.label.length * 12 + 24}" height="24" fill="${vc.bg}" rx="4"/>
  <text x="${180 + (vc.label.length * 12 + 24) / 2}" y="303" fill="${vc.text}" font-family="Arial, sans-serif" font-size="13" font-weight="700" text-anchor="middle">${escaped(vc.label)}</text>
  ${claimTextSvg}
  ${actualCardSvg}
</svg>`.trim();

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function defaultRenderPayload(claim) {
  return {
    claim: (claim.claim ?? '').slice(0, 484),
    correctedClaim: claim.correctedClaim ? claim.correctedClaim.slice(0, 484) : null,
    verdict: claim.verdict ?? 'unverified',
    confidence: claim.confidence ?? null,
    summary: (claim.summary ?? '').slice(0, 484),
    timecode: claim.chunkStartClock ?? null,
    sources: (claim.sources ?? []).slice(0, 3).map((source) => ({
      publisher: source.publisher ?? 'Unknown',
      title: source.title ?? null,
      url: source.url ?? null,
      textualRating: source.textualRating ?? null
    }))
  };
}

function normalizeClaimVersion(claim) {
  const parsed = Number.parseInt(String(claim?.version ?? 1), 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 1;
}

function buildIdempotencyKey(claim) {
  const claimId = String(claim?.claimId ?? '').trim() || 'claim-unknown';
  const version = normalizeClaimVersion(claim);
  const templateId = String(claim?.renderTemplateId ?? 'fc-lower-third-v1').trim();
  return `${claimId}:${version}:${templateId}`;
}

async function callTakumiRenderer(claim, options) {
  const endpoint = String(options.takumiRenderUrl ?? '').trim();
  if (!endpoint) {
    return {
      artifactUrl: localFallbackSvgArtifact(claim),
      rendererMode: 'local_fallback'
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        claimId: claim.claimId,
        runId: claim.runId,
        templateId: claim.renderTemplateId ?? 'fc-lower-third-v1',
        payload: claim.renderPayload ?? defaultRenderPayload(claim)
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 220);
      throw new Error(`Takumi render failed (${response.status}): ${detail}`);
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('image/')) {
      const imageBytes = await response.arrayBuffer();
      return {
        artifactUrl: `data:${contentType};base64,${Buffer.from(imageBytes).toString('base64')}`,
        rendererMode: 'takumi_remote'
      };
    }

    const body = await response.json();
    if (typeof body.artifactUrl === 'string' && body.artifactUrl.trim()) {
      return {
        artifactUrl: body.artifactUrl.trim(),
        rendererMode: 'takumi_remote'
      };
    }

    if (typeof body.imageBase64 === 'string' && body.imageBase64.trim()) {
      const mime = typeof body.mimeType === 'string' && body.mimeType.trim() ? body.mimeType : 'image/png';
      return {
        artifactUrl: `data:${mime};base64,${body.imageBase64.trim()}`,
        rendererMode: 'takumi_remote'
      };
    }

    throw new Error('Takumi response missing artifactUrl/imageBase64.');
  } finally {
    clearTimeout(timer);
  }
}

export function createRenderService(options = {}) {
  const jobsByClaimId = new Map();
  const jobsByRenderJobId = new Map();
  const jobsByIdempotencyKey = new Map();
  let onEvent = options.onEvent;
  let onJobUpdate = options.onJobUpdate;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const retryDelayMs = Math.max(100, options.retryDelayMs ?? 350);
  const takumiRenderUrl = options.takumiRenderUrl ?? '';

  function emit(type, payload = {}) {
    onEvent?.({
      type,
      at: new Date().toISOString(),
      ...payload
    });
  }

  function persistJob(job) {
    onJobUpdate?.(job);
  }

  function storeJob(job) {
    jobsByClaimId.set(job.claimId, job);
    jobsByRenderJobId.set(job.renderJobId, job);
    if (job.idempotencyKey) {
      jobsByIdempotencyKey.set(job.idempotencyKey, job.renderJobId);
    }
    persistJob(job);
  }

  async function processJob(claimId, renderJobId) {
    let current = jobsByRenderJobId.get(renderJobId);
    if (!current || current.claimId !== claimId || current.status !== 'queued') {
      return;
    }

    const latestForClaim = jobsByClaimId.get(claimId);
    if (!latestForClaim || latestForClaim.renderJobId !== renderJobId) {
      return;
    }

    current = {
      ...current,
      status: 'rendering',
      updatedAt: new Date().toISOString()
    };
    storeJob(current);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const active = jobsByRenderJobId.get(renderJobId);
      const latestForClaimNow = jobsByClaimId.get(claimId);
      if (
        !active ||
        !latestForClaimNow ||
        latestForClaimNow.renderJobId !== renderJobId ||
        active.claimId !== claimId
      ) {
        return;
      }

      try {
        const result = await callTakumiRenderer(active.claim, {
          takumiRenderUrl,
          timeoutMs
        });

        const latest = jobsByRenderJobId.get(renderJobId);
        const latestClaim = jobsByClaimId.get(claimId);
        if (
          !latest ||
          !latestClaim ||
          latestClaim.renderJobId !== renderJobId ||
          latest.claimId !== claimId
        ) {
          return;
        }

        const ready = {
          ...latest,
          attempts: attempt,
          status: 'ready',
          rendererMode: result.rendererMode,
          artifactUrl: result.artifactUrl,
          error: null,
          updatedAt: new Date().toISOString()
        };
        storeJob(ready);
        emit('claim.render_ready', {
          claimId,
          runId: ready.runId,
          renderJobId: ready.renderJobId,
          renderStatus: 'ready',
          artifactUrl: ready.artifactUrl,
          claimVersion: ready.claimVersion,
          idempotencyKey: ready.idempotencyKey
        });
        return;
      } catch (error) {
        const latest = jobsByRenderJobId.get(renderJobId);
        const latestClaim = jobsByClaimId.get(claimId);
        if (
          !latest ||
          !latestClaim ||
          latestClaim.renderJobId !== renderJobId ||
          latest.claimId !== claimId
        ) {
          return;
        }

        if (attempt >= maxAttempts) {
          const failed = {
            ...latest,
            attempts: attempt,
            status: 'failed',
            error: error.message,
            updatedAt: new Date().toISOString()
          };
          storeJob(failed);
          emit('claim.render_failed', {
            claimId,
            runId: failed.runId,
            renderJobId: failed.renderJobId,
            renderStatus: 'failed',
            error: failed.error,
            claimVersion: failed.claimVersion,
            idempotencyKey: failed.idempotencyKey
          });
          return;
        }
      }

      await sleep(retryDelayMs * attempt);
      current = jobsByRenderJobId.get(renderJobId) ?? current;
      if (current.renderJobId !== renderJobId) {
        return;
      }
    }
  }

  async function queueRender(claim, context = {}) {
    const normalizedClaim = {
      ...claim,
      renderTemplateId: claim.renderTemplateId ?? 'fc-lower-third-v1',
      renderPayload: claim.renderPayload ?? defaultRenderPayload(claim)
    };
    const claimVersion = normalizeClaimVersion(normalizedClaim);
    const force = Boolean(context.force);
    const baseIdempotencyKey =
      typeof context.idempotencyKey === 'string' && context.idempotencyKey.trim()
        ? context.idempotencyKey.trim()
        : buildIdempotencyKey(normalizedClaim);
    const idempotencyKey = force
      ? `${baseIdempotencyKey}:force:${context.forceNonce ?? randomUUID().slice(0, 8)}`
      : baseIdempotencyKey;

    const now = new Date().toISOString();

    if (!force) {
      const existingJobId = jobsByIdempotencyKey.get(baseIdempotencyKey);
      if (existingJobId) {
        const existing = jobsByRenderJobId.get(existingJobId);
        if (existing) {
          if (existing.status !== 'failed') {
            return existing;
          }

          const retried = {
            ...existing,
            runId: context.runId ?? existing.runId ?? normalizedClaim.runId ?? null,
            claim: normalizedClaim,
            claimVersion,
            idempotencyKey: baseIdempotencyKey,
            status: 'queued',
            error: null,
            updatedAt: now
          };
          storeJob(retried);
          emit('claim.render_queued', {
            claimId: normalizedClaim.claimId,
            runId: retried.runId,
            renderJobId: retried.renderJobId,
            renderStatus: 'queued',
            claimVersion: retried.claimVersion,
            idempotencyKey: retried.idempotencyKey
          });
          void processJob(normalizedClaim.claimId, retried.renderJobId);
          return retried;
        }
      }
    }

    const renderJob = {
      renderJobId: randomUUID(),
      claimId: normalizedClaim.claimId,
      runId: context.runId ?? normalizedClaim.runId ?? null,
      claimVersion,
      idempotencyKey,
      status: 'queued',
      attempts: 0,
      claim: normalizedClaim,
      artifactUrl: null,
      error: null,
      rendererMode: null,
      createdAt: now,
      updatedAt: now
    };

    storeJob(renderJob);
    emit('claim.render_queued', {
      claimId: normalizedClaim.claimId,
      runId: renderJob.runId,
      renderJobId: renderJob.renderJobId,
      renderStatus: 'queued',
      claimVersion: renderJob.claimVersion,
      idempotencyKey: renderJob.idempotencyKey
    });

    void processJob(normalizedClaim.claimId, renderJob.renderJobId);
    return renderJob;
  }

  function getByClaimId(claimId) {
    return jobsByClaimId.get(claimId) ?? null;
  }

  function clear() {
    jobsByClaimId.clear();
    jobsByRenderJobId.clear();
    jobsByIdempotencyKey.clear();
  }

  function setEventHandler(handler) {
    onEvent = handler;
  }

  function setJobUpdateHandler(handler) {
    onJobUpdate = handler;
  }

  return {
    queueRender,
    getByClaimId,
    clear,
    setEventHandler,
    setJobUpdateHandler
  };
}
