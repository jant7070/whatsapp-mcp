import express, { type Request, type Response, type NextFunction, type Express } from 'express';
import rateLimit from 'express-rate-limit';

import { buildRouter } from './routes';

interface AppDeps {
  apiKey: string;
  deploymentMode: 'local' | 'cloud';
}

export function buildApp({ apiKey, deploymentMode }: AppDeps): Express {
  const app = express();
  app.set('trust proxy', deploymentMode === 'cloud' ? 1 : false);
  app.use(express.json({ limit: '256kb' }));

  // HTTPS enforcement (cloud only). Caddy sets X-Forwarded-Proto.
  if (deploymentMode === 'cloud') {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.headers['x-forwarded-proto'] !== 'https') {
        return res.status(426).json({
          error: 'HTTPS is required in cloud mode. Do not expose this service without TLS.',
        });
      }
      next();
    });
  }

  // Safe request logger.
  // Path-only — query strings are skipped because they may contain JIDs / search terms.
  // Bodies, JIDs, QR data, and auth tokens are NEVER logged.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - start,
          ip: req.ip,
        }),
      );
    });
    next();
  });

  // Bearer auth on every route.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || token !== apiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // Per-IP rate limit on everything; /send adds a stricter cap inside the router.
  const generalLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(generalLimiter);

  app.use(buildRouter());

  return app;
}
