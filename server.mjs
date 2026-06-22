import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMikuChatEndRequest, handleMikuChatRequest } from './server/deepseek-miku.mjs';
import { handleVocaloidLyricsRequest, handleVocaloidSearchRequest } from './server/vocaloid-knowledge.mjs';
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest, handleSurveyRequest, handleSurveyStatsRequest } from './server/auth-leaderboard.mjs';

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
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const contentTypeFor = (filePath) => mimeTypes[extname(filePath)] || 'application/octet-stream';

// Extensions that benefit from HTTP compression. Binary/already-compressed
// formats (png/webp/mp3/woff2/ico) are excluded — re-compressing wastes CPU
// and can even grow the payload.
const COMPRESSIBLE_EXT = new Set(['.js', '.css', '.json', '.svg', '.html']);

// ---- Pre-compressed cache (br + gz) for text assets ----------------------
// Brotli is expensive; recompressing per request would pin CPU on a hot file
// (the 1.36MB biliboard JSON in particular). We keep both encodings in memory
// keyed by absolute path, and only for compressible text files. Binary files
// skip this entirely (Range still works on the raw file).
//
// The big files live under dist/assets/*.{js,css,json} and dist/data/*.json
// (biliboard JSON is 1.36MB) — we pre-warm those at startup. Smaller text
// files served from dist root (index.html, stats.html) are compressed lazily
// on first request and then memoized, so we still get gzip on them without
// paying any startup cost or scanning the whole dist tree.
const precompressed = new Map(); // absPath -> { br: Buffer, gz: Buffer, size: number }

const PRECOMPRESS_DIRS = ['assets', 'data'];
const PRECOMPRESS_EXTS = new Set(['.js', '.css', '.json']);

const compressOnce = (abs) => {
  const raw = readFileSync(abs);
  const entry = { br: brotliCompressSync(raw), gz: gzipSync(raw), size: raw.length };
  precompressed.set(abs, entry);
  return entry;
};

const getPrecompressed = (abs) => precompressed.get(abs) || compressOnce(abs);

const buildPrecompressedCache = () => {
  let count = 0, totalRaw = 0, totalBr = 0;
  for (const sub of PRECOMPRESS_DIRS) {
    const dir = join(distDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!PRECOMPRESS_EXTS.has(extname(name))) continue;
      const entry = compressOnce(join(dir, name));
      count += 1;
      totalRaw += entry.size;
      totalBr += entry.br.length;
    }
  }
  console.log(`[compress] pre-warmed ${count} files: raw=${(totalRaw/1024).toFixed(0)}KB br=${(totalBr/1024).toFixed(0)}KB (${(100*totalBr/(totalRaw||1)).toFixed(0)}%)`);
};

// ---- ETag (weak) ---------------------------------------------------------
const etagFor = (fileStat) => {
  const h = createHash('md5').update(`${fileStat.size}:${fileStat.mtimeMs}`).digest('hex').slice(0, 16);
  return `W/"${h}"`;
};

// ---- Cache-Control policy ------------------------------------------------
// /assets/* are Vite hash-named → safe to mark immutable for a year.
// Everything else under dist/ (scene/, sprites/, audio/, favicon, ...) →
// 1 hour, revalidate via ETag. HTML docs must always revalidate (no-cache),
// otherwise users get stuck on stale JS bundle references after a deploy.
const cacheControlFor = (urlPath, filePath) => {
  if (filePath.endsWith('.html')) return 'no-cache';
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
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
  if (req.url?.startsWith('/api/survey/stats')) {
    await handleSurveyStatsRequest(req, res);
    return;
  }
  if (req.url?.startsWith('/api/survey')) {
    await handleSurveyRequest(req, res);
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
  const ext = extname(filePath);
  const contentType = contentTypeFor(filePath);
  const etag = etagFor(fileStat);

  // Decide encoding up front so the ETag can be suffixed per variant
  // (-br / -gz). A shared ETag across raw/br/gz bodies risks cross-encoding
  // cache poisoning if a CDN/reverse-proxy ignores Vary. Range requests and
  // incompressible types always use the raw ETag.
  const range = req.headers.range;
  let enc = ''; // '' | 'br' | 'gzip'
  if (!range && COMPRESSIBLE_EXT.has(ext)) {
    const acceptEnc = req.headers['accept-encoding'] || '';
    const cached = getPrecompressed(filePath);
    if (cached && acceptEnc.includes('br')) enc = 'br';
    else if (cached && acceptEnc.includes('gzip')) enc = 'gzip';
  }
  const responseEtag = enc ? etag.replace(/"$/, `-${enc === 'br' ? 'br' : 'gz'}"`) : etag;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', cacheControlFor(urlPath, filePath));
  res.setHeader('ETag', responseEtag);
  if (enc) res.setHeader('Vary', 'Accept-Encoding');

  // Conditional request: client's cached ETag still fresh → 304, no body.
  if (req.headers['if-none-match'] === responseEtag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  // Range request: serve raw byte slice. We deliberately do NOT compress here
  // — browsers don't negotiate compression on Range requests and audio/sprite
  // byte-serving must stay bit-exact. Only non-range requests are compressed.
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

  // Non-range request. If we resolved a compressed variant above, stream the
  // pre-compressed buffer (brotli preferred over gzip per Accept-Encoding).
  // Avoids per-request brotli CPU and a full raw-file read from disk on every
  // hit. ETag already suffixed and Vary already set above.
  if (enc) {
    const cached = getPrecompressed(filePath);
    if (enc === 'br' && cached?.br) {
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', String(cached.br.length));
      res.statusCode = 200;
      res.end(cached.br);
      return;
    }
    if (enc === 'gzip' && cached?.gz) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(cached.gz.length));
      res.statusCode = 200;
      res.end(cached.gz);
      return;
    }
  }

  // Fallthrough: client sent no usable Accept-Encoding, OR the file is binary
  // (png/webp/mp3/woff2/ico — intentionally never compressed). Stream raw from
  // disk. This keeps memory bounded and leaves Range behavior intact for the
  // audio/sprite byte-serving that happens above.
  res.statusCode = 200;
  res.setHeader('Content-Length', String(fileStat.size));
  createReadStream(filePath).pipe(res);
}).listen(port, host, () => {
  buildPrecompressedCache();
  console.log(`Game server listening on http://${host}:${port}`);
});
