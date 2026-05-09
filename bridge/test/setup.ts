// Test bootstrap. Use an in-memory SQLite database; freeze env vars.

import { beforeAll } from 'vitest';

process.env.BRIDGE_API_KEY = 'test-key-test-key-test-key-test-key-test';
process.env.DEPLOYMENT_MODE = 'local';
process.env.STORE_DB_PATH = ':memory:';
process.env.MEDIA_CACHE_DIR =
  process.platform === 'win32' ? `${process.env.TEMP ?? '.'}\\wm-test-media` : '/tmp/wm-test-media';
process.env.MEDIA_INLINE_RESPONSE_MB = '4';
process.env.MEDIA_MAX_INBOUND_MB = '16';
process.env.MEDIA_MAX_OUTBOUND_MB = '16';
process.env.IDEMPOTENCY_TTL_HOURS = '24';

beforeAll(() => {
  // Ensure media cache dir exists
  const fs = require('fs');
  try {
    fs.mkdirSync(process.env.MEDIA_CACHE_DIR!, { recursive: true });
  } catch {
    // already exists
  }
});
