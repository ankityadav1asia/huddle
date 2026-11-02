// Vercel entry for the Watch Party API. vercel.json rewrites /api/<path> here as ?__path=<path>; the original
// replay endpoint keeps its own function (api/ai.js). Background jobs run inside long-poll requests on Vercel.
import { handleApi } from '../lib/http/app.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    const search = url.searchParams.toString();
    req.url = `/api/${original.replace(/^\/+/, '')}${search ? `?${search}` : ''}`;
  }
  return handleApi(req, res);
}
