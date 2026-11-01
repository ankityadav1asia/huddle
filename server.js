// Local dev server: serves public/ and runs api/ai.js, the same function Vercel deploys.
// Usage: npm start  (reads ANTHROPIC_API_KEY or GEMINI_API_KEY from .env if present)
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const { default: handler } = await import('./api/ai.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/ai') {
    req.body = req.method === 'POST' ? await readBody(req) : null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    return handler(req, res);
  }
  const file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  const ai = process.env.ANTHROPIC_API_KEY ? 'Claude' : process.env.OPENROUTER_API_KEY ? `OpenRouter (${process.env.OPENROUTER_MODEL || 'google/gemini-3.5-flash-lite'})` : process.env.GEMINI_API_KEY ? 'Gemini' : 'offline engine (no API key in .env)';
  console.log(`Huddle running at http://localhost:${port}  ·  AI: ${ai}`);
});
