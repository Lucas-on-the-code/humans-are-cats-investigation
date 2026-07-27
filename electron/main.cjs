const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PORT = 3001;
const API_SERVER = process.env.API_SERVER || 'https://cats.renchengzhang.com';
const distDir = path.join(__dirname, '..', 'dist');
const publicDir = path.join(__dirname, '..', 'public');

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
  const targetUrl = new URL(req.url, API_SERVER);
  
  // Build clean headers for the upstream request
  const cleanHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value && !HOP_HEADERS.has(key.toLowerCase())) {
      cleanHeaders[key] = value;
    }
  }
  cleanHeaders['host'] = targetUrl.hostname;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: cleanHeaders,
    rejectUnauthorized: false,
  };

  console.log(`[proxy] ${req.method} ${targetUrl.pathname}`);

  const proxy = https.request(options, (proxyRes) => {
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
