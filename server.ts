// Huddle server: serves public/ and the Watch Party API (/api/*), and runs the background worker in-process.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadDotEnv, config } from './lib/config.ts';

loadDotEnv();
// npm start -- --port 3100
const portFlag = process.argv.indexOf('--port');
if (portFlag > 0 && process.argv[portFlag + 1]) process.env.PORT = process.argv[portFlag + 1];

const { handleApi } = await import('./lib/http/app.ts');
const { getDb } = await import('./lib/db/index.ts');
const { startWorker } = await import('./lib/jobs/worker.ts');
const { ensureDemoMatches } = await import('./lib/match/feed.ts');
const { aiStatus } = await import('./lib/ai/index.ts');
const { log } = await import('./lib/log.ts');

const publicDir = path.join(ROOT, 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000',
};
const PAGES: Record<string, string> = { '/': 'index.html', '/mod': 'mod.html' };
const REDIRECTS: Record<string, string> = { '/replay': '/', '/replay.html': '/' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  if (REDIRECTS[url.pathname]) {
    res.writeHead(302, { location: REDIRECTS[url.pathname] }).end();
    return;
  }
  const rel = PAGES[url.pathname] || decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...SECURITY });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const cfg = config();
const db = await getDb();
await ensureDemoMatches(db);
if (cfg.worker.inline) startWorker(db);
server.listen(cfg.port, () => {
  const ai = aiStatus();
  console.log(`Huddle running at http://localhost:${cfg.port}`);
  console.log(`  database: ${db.kind === 'pglite' ? `embedded PGlite (${path.relative(ROOT, cfg.dataDir)}/pglite)` : 'Postgres (DATABASE_URL)'}`);
  console.log('  joining: guest profiles (display name + handle)');
  console.log(`  AI Co-host: ${ai.available ? `primary ${ai.primary}${ai.fallback ? `, fallback ${ai.fallback}` : ', no fallback'}` : 'no AI key set (match alerts and Catch Me Up use verified-data templates)'}`);
  log.info('server.start', { port: cfg.port, db: db.kind });
});
