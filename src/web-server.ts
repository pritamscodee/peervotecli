/**
 * PearPass frontend static server (port 3000).
 *
 * Serves the landing page (/) and dashboard (/dashboard) from web/.
 * All API calls are made by the browser directly to the backend on
 * port 3001 (CORS-enabled), so this server only ships static files.
 */
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.WEB_PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const ROUTES: Record<string, string> = {
  '/': '/index.html',
  '/dashboard': '/dashboard.html',
};

function serveStatic(urlPathname: string, res: import('node:http').ServerResponse): void {
  const route = ROUTES[urlPathname] ?? urlPathname.replace(/\/$/, '');
  const filePath = path.resolve(WEB_ROOT, '.' + route);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log(`  ✅ PearPass frontend running on port ${PORT}:`);
  console.log(`     • Landing page:  http://localhost:${PORT}/`);
  console.log(`     • Dashboard:     http://localhost:${PORT}/dashboard`);
  console.log('');
});