import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMikuChatEndRequest, handleMikuChatRequest } from './server/deepseek-miku.mjs';
import { handleVocaloidLyricsRequest, handleVocaloidSearchRequest } from './server/vocaloid-knowledge.mjs';
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest } from './server/auth-leaderboard.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(root, 'dist');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

// Fail-loud: the HMAC SECRET must be set in production. Without it, every restart
// invalidates all sessions/runTokens and leaderboard submissions silently fail (F3).
if (!process.env.GAME_SERVER_SECRET || process.env.GAME_SERVER_SECRET.length < 32) {
  console.error('FATAL: GAME_SERVER_SECRET must be set to a random string of >= 32 chars.');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
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
  console.log(`Game server listening on http://${host}:${port}`);
});
