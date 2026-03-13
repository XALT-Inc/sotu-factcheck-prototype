import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isControlAction(url: string, method: string): boolean {
  if (method !== 'POST') return false;
  if (url === '/api/start' || url === '/api/stop') return true;
  if (/^\/api\/claims\/[^/]+\/(approve-output|reject-output|generate-package|render-image|tag-override)$/.test(url)) return true;
  return false;
}

export function isReadProtected(url: string, method: string, protectReadEndpoints: boolean): boolean {
  if (method !== 'GET' || !protectReadEndpoints) return false;
  if (url === '/api/claims' || url === '/api/runs' || url === '/api/output-packages' || url === '/events') return true;
  if (/^\/api\/claims\/[^/]+\/(output-package|render-job)$/.test(url)) return true;
  return false;
}

export function registerAuthHook(app: FastifyInstance, options: { controlPassword: string; protectReadEndpoints: boolean }): void {
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    const needsAuth = isControlAction(url, request.method) || isReadProtected(url, request.method, options.protectReadEndpoints);
    if (!needsAuth || !options.controlPassword) return;

    const headerValue = request.headers['x-control-password'];
    const provided = typeof headerValue === 'string' && headerValue.trim() ? headerValue.trim() : '';
    if (!provided) {
      const queryValue = (request.query as Record<string, string>)?.control_password;
      if (typeof queryValue === 'string' && queryValue.trim() && safeEquals(queryValue.trim(), options.controlPassword)) return;
      return reply.status(401).send({ ok: false, error: 'Unauthorized. Provide x-control-password header or ?control_password= query.' });
    }
    if (!safeEquals(provided, options.controlPassword)) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized. Provide x-control-password header or ?control_password= query.' });
    }
  });
}
