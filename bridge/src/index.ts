import { buildApp } from './app';
import { startWhatsApp } from './baileys';
import { initDb } from './db';
import { startMediaSweeper } from './media';
import { startProfileSweeper } from './profile';
import { startIdempotencyPurger } from './idempotency';

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const DEPLOYMENT_MODE = (process.env.DEPLOYMENT_MODE || 'local') as 'local' | 'cloud';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '3001', 10);
// Bind to all interfaces inside the container; Docker's `127.0.0.1:NNNN:NNNN`
// port mapping is what restricts host-side access to localhost in local mode.
const BIND_HOST = '0.0.0.0';

if (!BRIDGE_API_KEY) {
  console.error(
    'FATAL: BRIDGE_API_KEY is not set. Generate one with `openssl rand -hex 32` and put it in .env.',
  );
  process.exit(1);
}

if (DEPLOYMENT_MODE === 'cloud' && BRIDGE_API_KEY.length < 32) {
  console.error(
    'FATAL: BRIDGE_API_KEY must be at least 32 characters in cloud mode. Generate one with `openssl rand -hex 32`.',
  );
  process.exit(1);
}

if (DEPLOYMENT_MODE === 'cloud' && !process.env.BRIDGE_PUBLIC_BASE_URL) {
  console.warn(
    'WARN: Cloud mode without BRIDGE_PUBLIC_BASE_URL — signed media URLs will use the request Host header and may leak docker-internal hostnames.',
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initDb();
startMediaSweeper();
startProfileSweeper();
startIdempotencyPurger();

const app = buildApp({ apiKey: BRIDGE_API_KEY, deploymentMode: DEPLOYMENT_MODE });

app.listen(BRIDGE_PORT, BIND_HOST, () => {
  console.log(`Bridge running on ${BIND_HOST}:${BRIDGE_PORT} [${DEPLOYMENT_MODE} mode]`);
});

startWhatsApp().catch((err) => {
  console.error('Initial WhatsApp start failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
