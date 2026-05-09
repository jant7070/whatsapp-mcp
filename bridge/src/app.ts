import express, { type Request, type Response, type NextFunction, type Express } from 'express';

import { buildRouter } from './routes';

interface AppDeps {
  apiKey: string;
  deploymentMode: 'local' | 'cloud';
}

export function buildApp({ apiKey, deploymentMode }: AppDeps): Express {
  const app = express();
  app.set('trust proxy', deploymentMode === 'cloud' ? 1 : false);
  // Bumped from 256kb so /send/media base64 payloads up to ~32MB JSON-encoded fit.
  app.use(express.json({ limit: '32mb' }));

  // HTTPS enforcement (cloud only).
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

  // Safe request logger — path-only.
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

  app.use(buildRouter());

  return app;
}
