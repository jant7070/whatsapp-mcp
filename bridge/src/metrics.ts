// Prometheus metrics. Default Node process metrics + bridge-specific
// counters/histograms. Exposed at GET /metrics (bearer-authed, internal only).

import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'whatsapp_bridge_http_requests_total',
  help: 'HTTP requests handled by the bridge.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'whatsapp_bridge_http_request_duration_seconds',
  help: 'Bridge HTTP request duration in seconds.',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const sendMessages = new Counter({
  name: 'whatsapp_bridge_send_total',
  help: 'Outbound WhatsApp messages by tool/result.',
  labelNames: ['tool', 'result'],
  registers: [registry],
});

export const idempotencyReplays = new Counter({
  name: 'whatsapp_bridge_idempotency_replays_total',
  help: 'Idempotency-replayed responses.',
  labelNames: ['tool'],
  registers: [registry],
});

export const rateLimitDrops = new Counter({
  name: 'whatsapp_bridge_rate_limit_drops_total',
  help: 'Requests dropped by per-tool/per-target rate limit.',
  labelNames: ['scope'],
  registers: [registry],
});

export const errorsLastHour = new Gauge({
  name: 'whatsapp_bridge_errors_last_hour',
  help: 'Rolling count of 5xx responses in the trailing hour.',
  registers: [registry],
});

export const connectionStatusGauge = new Gauge({
  name: 'whatsapp_bridge_connection_status',
  help: '0=disconnected, 1=connecting, 2=connected.',
  registers: [registry],
});

export const cacheBytesGauge = new Gauge({
  name: 'whatsapp_bridge_media_cache_bytes',
  help: 'On-disk media cache size in bytes.',
  registers: [registry],
});

// Rolling 1h error counter — kept in-process; no Prom-side rate window so the
// /status endpoint can read a precise count without rate() math on the caller.
const errorTimestamps: number[] = [];
export function recordHttpError(): void {
  const now = Date.now();
  errorTimestamps.push(now);
  // Drop entries older than 1h.
  const cutoff = now - 3600_000;
  while (errorTimestamps.length > 0 && errorTimestamps[0]! < cutoff) {
    errorTimestamps.shift();
  }
  errorsLastHour.set(errorTimestamps.length);
}
export function errorsInLastHour(): number {
  const cutoff = Date.now() - 3600_000;
  while (errorTimestamps.length > 0 && errorTimestamps[0]! < cutoff) {
    errorTimestamps.shift();
  }
  errorsLastHour.set(errorTimestamps.length);
  return errorTimestamps.length;
}

// Express middleware: records duration + counter for every request. Routes
// that don't match send `route='unmatched'`.
export function metricsMw() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route?.path as string | undefined) ?? req.path ?? 'unmatched';
      const status = String(res.statusCode);
      httpRequests.inc({ method: req.method, route, status });
      const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
      httpDuration.observe({ method: req.method, route }, elapsedSec);
      if (res.statusCode >= 500) recordHttpError();
    });
    next();
  };
}
