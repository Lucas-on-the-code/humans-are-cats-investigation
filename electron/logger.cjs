const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const MAX_LOG_FILES = 5;

let logStream = null;
let currentSize = 0;
let logFile = null;
let initialized = false;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function rotateLogs() {
  const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('game-') && f.endsWith('.log')).sort();
  while (files.length >= MAX_LOG_FILES) fs.unlinkSync(path.join(LOG_DIR, files.shift()));
}

function openLogStream() {
  if (logStream) logStream.end();
  ensureDir(LOG_DIR);
  rotateLogs();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  logFile = path.join(LOG_DIR, `game-${ts}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  currentSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  writeRaw(`=== Log started ${new Date().toISOString()} ===`);
}

function writeRaw(line) {
  if (!logStream) return;
  const text = line + '\n';
  logStream.write(text);
  currentSize += Buffer.byteLength(text);
  if (currentSize > MAX_LOG_SIZE) openLogStream();
}

function formatArgs(args) {
  return Array.from(args).map(arg => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(' ');
}

function log(level, ...args) {
  if (!initialized) return;
  const line = `[${new Date().toISOString()}] [${level}] ${formatArgs(args)}`;
  writeRaw(line);
  const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  fn(`[${level.toLowerCase()}]`, ...args);
}

module.exports = {
  init() { if (!initialized) { initialized = true; openLogStream(); log('INFO', 'Logger initialized'); } },
  info(...args) { log('INFO', ...args); },
  warn(...args) { log('WARN', ...args); },
  error(...args) { log('ERROR', ...args); },
  debug(...args) { log('DEBUG', ...args); },
  getCurrentLogFile() { return logFile; },
  shutdown() { if (logStream) { writeRaw('=== Log ended ==='); logStream.end(); logStream = null; } initialized = false; }
};
