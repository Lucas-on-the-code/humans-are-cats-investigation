import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMikuChatEndRequest, handleMikuChatRequest } from './server/deepseek-miku.mjs';
import { handleVocaloidLyricsRequest, handleVocaloidSearchRequest } from './server/vocaloid-knowledge.mjs';
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest } from './server/auth-leaderboard.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(root, 'dist');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

// Load .env file
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  let raw = readFileSync(envPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const lines = raw.includes('\r') ? raw.split('\r\n') : raw.split('\n');
  const loaded = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) { process.env[key] = value; loaded.push(key); }
    }
  }
  console.log('[env] Loaded .env (keys: ' + (loaded.join(', ') || 'none') + ')');
}

// Integrity manifest
let integrityManifest = null;
try {
  const ip = join(distDir, 'integrity.json');
  if (existsSync(ip)) {
    integrityManifest = JSON.parse(readFileSync(ip, 'utf8'));
    console.log('[integrity] Loaded manifest v' + integrityManifest.version);
  }
} catch (err) {
  console.warn('[integrity] ' + err.message);
}

export const getIntegrityManifest = () => integrityManifest;

if (!process.env.GAME_SERVER_SECRET || process.env.GAME_SERVER_SECRET.length < 32) {
  console.error('FATAL: GAME_SERVER_SECRET must be >= 32 chars.');
  console.error('Run genkey.cjs to generate one, or create .env with GAME_SERVER_SECRET=<key>');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.mp3':  'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ico':  'image/x-icon',
};
const mimeOf = (p) => MIME[p.slice(p.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';

const writeJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

// Safe static file server — never throws
function tryServeStatic(res, filePath) {
  try {
    if (!existsSync(filePath)) return false;
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    res.statusCode = 200;
    res.setHeader('Content-Type', mimeOf(filePath));
    res.setHeader('Content-Length', String(st.size));
    const stream = createReadStream(filePath);
    stream.on('error', function(e) {
      if (!res.headersSent) writeJson(res, 500, { error: 'STREAM_ERROR', detail: e.message });
    });
    stream.pipe(res);
    return true;
  } catch (err) {
    console.warn('[static] ' + filePath + ': ' + err.message);
    return false;
  }
}

import { createServer } from 'node:http';

const server = createServer(async function(req, res) {
  try {
    const url = req.url || '/';
    if (url.startsWith('/api/miku-chat/end'))    { await handleMikuChatEndRequest(req, res); return; }
    if (url.startsWith('/api/miku-chat'))         { await handleMikuChatRequest(req, res); return; }
    if (url.startsWith('/api/vocaloid-search'))   { await handleVocaloidSearchRequest(req, res); return; }
    if (url.startsWith('/api/vocaloid-lyrics'))   { await handleVocaloidLyricsRequest(req, res); return; }
    if (url.startsWith('/api/miku-memory'))       { await handleMikuMemoryRequest(req, res); return; }
    if (url.startsWith('/api/auth'))              { await handleAuthRequest(req, res); return; }
    if (url.startsWith('/api/runs/start'))        { await handleRunStartRequest(req, res); return; }
    if (url.startsWith('/api/leaderboard'))       { await handleLeaderboardRequest(req, res); return; }
    if (url === '/api/integrity' && req.method === 'GET') {
      return writeJson(res, integrityManifest ? 200 : 404, integrityManifest || { error: 'NOT_FOUND' });
    }
    if (url === '/health') {
      return writeJson(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()) });
    }

    // Static files
    const urlPath = decodeURIComponent(url.split('?')[0]);
    const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let fp = join(distDir, safe === '/' ? 'index.html' : safe);
    if (!fp.startsWith(distDir)) { writeJson(res, 403, { error: 'FORBIDDEN' }); return; }

    if (tryServeStatic(res, fp)) return;
    tryServeStatic(res, join(distDir, 'index.html'));

    // Nothing served — show API info
    if (!res.headersSent) {
      writeJson(res, 200, {
        name: 'Humans are Cats: Investigation - Server',
        endpoints: ['/api/auth', '/api/leaderboard', '/api/runs/start', '/api/miku-chat', '/health'],
      });
    }
  } catch (err) {
    console.error('[server] Unhandled error:', err.message);
    if (!res.headersSent) writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + port + ' is already in use.');
    console.error('Stop the other process or use: set PORT=3001 && node server.mjs');
  } else {
    console.error('Server error: ' + err.message);
  }
  process.exit(1);
});

server.listen(port, host, function() {
  console.log('Server listening on http://' + host + ':' + port);
});
