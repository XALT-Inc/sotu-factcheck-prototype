import type { PipelineEvent } from '../types.js';
import { SSE_REPLAY_MAX, SSE_REPLAY_INITIAL, SSE_HEARTBEAT_INTERVAL_MS, SSE_RETRY_MS } from '../constants.js';
import type { RingBuffer } from '../ring-buffer.js';
import type { ServerResponse } from 'node:http';

export interface SseManager {
  clients: Map<ServerResponse, string | null>;
  broadcast(event: PipelineEvent): void;
  addClient(raw: ServerResponse, lastEventId: number | null, eventHistory: RingBuffer<PipelineEvent>, filterRunId?: string | null): void;
}

export function createSseManager(): SseManager {
  const clients = new Map<ServerResponse, string | null>(); // value = runId filter (null = all)

  function matchesFilter(event: PipelineEvent, filterRunId: string | null): boolean {
    if (!filterRunId) return true;
    return (event as Record<string, unknown>).runId === filterRunId;
  }

  function broadcast(event: PipelineEvent): void {
    const e = event as Record<string, unknown>;
    const data = `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const [client, filterRunId] of clients) {
      if (!matchesFilter(event, filterRunId)) continue;
      try { if (!client.destroyed) client.write(data); } catch { clients.delete(client); }
    }
  }

  function addClient(raw: ServerResponse, lastEventId: number | null, eventHistory: RingBuffer<PipelineEvent>, filterRunId: string | null = null): void {
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    raw.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const allReplay = lastEventId !== null
      ? eventHistory.filter((ev) => ((ev as Record<string, unknown>).seq as number) > lastEventId).slice(-SSE_REPLAY_MAX)
      : eventHistory.slice(-SSE_REPLAY_INITIAL);

    const replayEvents = filterRunId ? allReplay.filter((ev) => matchesFilter(ev, filterRunId)) : allReplay;

    clients.set(raw, filterRunId);
    raw.on('error', () => { clients.delete(raw); });

    for (const ev of replayEvents) {
      const e = ev as Record<string, unknown>;
      raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      try { if (!raw.destroyed) raw.write(': heartbeat\n\n'); else { clearInterval(heartbeat); clients.delete(raw); } }
      catch { clearInterval(heartbeat); clients.delete(raw); }
    }, SSE_HEARTBEAT_INTERVAL_MS);

    raw.on('close', () => { clearInterval(heartbeat); clients.delete(raw); });
  }

  return { clients, broadcast, addClient };
}
