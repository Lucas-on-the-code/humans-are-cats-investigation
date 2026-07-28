const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PORT = 3001;
const distDir = path.join(__dirname, '..', 'dist');
const publicDir = path.join(__dirname, '..', 'public');

// Load server address from config.json (next to .exe), with fallbacks
function loadApiServer() {
  const configPath = path.join(path.dirname(app.getPath('exe')), 'resources', 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.apiServer) {
        console.log(`[config] API server: ${config.apiServer}`);
        return config.apiServer;
      }
    }
  } catch (e) {
    console.warn('[config] Failed to read config.json:', e.message);
  }
  const fallback = process.env.API_SERVER || 'https://cats.renchengzhang.com/steam-api/';
  console.log(`[config] Using fallback API server: ${fallback}`);
  return fallback;
}

let API_SERVER = 'https://cats.renchengzhang.com/steam-api/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.mp3':  'audio/mpeg',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
}

// Hop-by-hop headers that should NOT be forwarded
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

// Proxy API requests to the remote server
function proxyApi(req, res) {
  const baseUrl = new URL(API_SERVER);
  const targetPath = baseUrl.pathname.replace(/\/$/, '') + req.url;
  const targetUrl = new URL(targetPath, API_SERVER);
  
  // Build clean headers for the upstream request
  const cleanHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value && !HOP_HEADERS.has(key.toLowerCase())) {
      cleanHeaders[key] = value;
    }
  }
  cleanHeaders['host'] = targetUrl.hostname;

  const transport = targetUrl.protocol === 'https:' ? https : http;
  const defaultPort = targetUrl.protocol === 'https:' ? 443 : 80;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || defaultPort,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: cleanHeaders,
    ...(targetUrl.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
  };

  console.log(`[proxy] ${req.method} ${targetUrl.pathname}`);

  const proxy = transport.request(options, (proxyRes) => {
    console.log(`[proxy] ← ${proxyRes.statusCode}`);
    // Strip hop-by-hop response headers
    const resHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value && !HOP_HEADERS.has(key.toLowerCase())) {
        resHeaders[key] = value;
      }
    }
    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);
  });

  proxy.on('error', (err) => {
    console.error(`[proxy] ERROR: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'API_PROXY_ERROR', detail: err.message }));
  });

  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // Proxy /api/* to remote server
  if (urlPath.startsWith('/api/')) {
    return proxyApi(req, res);
  }

  // Try dist/ first, then public/
  const distPath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);
  const publicPath = path.join(publicDir, urlPath);

  if (fs.existsSync(distPath) && fs.statSync(distPath).isFile()) {
    return serveFile(res, distPath);
  }
  if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
    return serveFile(res, publicPath);
  }

  // SPA fallback
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(path.join(distDir, 'index.html')).pipe(res);
});

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#050510',
    title: 'Humans are Cats: Investigation',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  API_SERVER = loadApiServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Game: http://localhost:${PORT}  →  API: ${API_SERVER}`);
    createWindow();
  });
});

app.on('window-all-closed', () => {
  server.close();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
