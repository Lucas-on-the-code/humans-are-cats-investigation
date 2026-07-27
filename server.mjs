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
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
  const lines = raw.split(/
?
/);
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
  console.log(`[env] Loaded .env file (keys: ${loaded.join(', ') || 'none'})`);
}

// Integrity manifest
let integrityManifest = null;
const integrityPath = join(distDir, 'integrity.json');
try {
  if (existsSync(integrityPath)) {
    integrityManifest = JSON.parse(readFileSync(integrityPath, 'utf8'));
    console.log(`[integrity] Loaded manifest v${integrityManifest.version}`);
  } else {
    console.warn('[integrity] No integrity.json found');
  }
} catch (err) {
  console.warn('[integrity] Failed to load manifest:', err.message);
}

export const getIntegrityManifest = () => integrityManifest;

// Fail-loud: GAME_SERVER_SECRET must be set
if (!process.env.GAME_SERVER_SECRET || process.env.GAME_SERVER_SECRET.length < 32) {
  console.error('FATAL: GAME_SERVER_SECRET must be set to >= 32 chars.');
  console.error('Create a .env file with: GAME_SERVER_SECRET=<your-key>');
  console.error('Or set the environment variable before starting.');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
};

const contentTypeFor = (filePath) => {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return mimeTypes[ext] || 'application/octet-stream';
};

import { createServer } from 'node:http';

createServer(async (req, res) => {
  if (req.url?.startsWith('/api/miku-chat/end')) {
    await handleMikuChatEndRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/miku-chat')) {
    await handleMikuChatRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/vocaloid-search')) {
    await handleVocaloidSearchRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/vocaloid-lyrics')) {
    await handleVocaloidLyricsRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/miku-memory')) {
    await handleMikuMemoryRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/auth')) {
    await handleAuthRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/runs/start')) {
    await handleRunStartRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/leaderboard')) {
    await handleLeaderboardRequest(req, res);
    return;
  }
  if (req.url === '/api/integrity' && req.method === 'GET') {
    res.statusCode = integrityManifest ? 200 : 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(JSON.stringify(integrityManifest || { error: 'NOT_FOUND' }));
    return;
  }

  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(distDir, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(distDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(distDir, 'index.html');
  }

  const fileStat = statSync(filePath);
  const contentType = contentTypeFor(filePath);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : fileStat.size - 1;
      if (Number.isInteger(start) && Number.isInteger(end) && start <= end && start >= 0 && end < fileStat.size) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileStat.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${fileStat.size}`);
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', String(fileStat.size));
  createReadStream(filePath).pipe(res);
}).listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
