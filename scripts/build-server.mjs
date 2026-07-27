import { mkdir, copyFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'server-dist');
const CRLF = '\r\n';

const copyDir = async (src, dest) => {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src)) {
    const sp = join(src, entry), dp = join(dest, entry);
    (await stat(sp)).isDirectory() ? await copyDir(sp, dp) : await copyFile(sp, dp);
  }
};

const bat = (lines) => lines.join(CRLF) + CRLF;
const sh  = (lines) => lines.join('\n') + '\n';

const main = async () => {
  console.log('[server-pack] Building server distribution...');
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });

  await copyDir(join(ROOT, 'server'), join(OUT, 'server'));
  await copyFile(join(ROOT, 'server.mjs'), join(OUT, 'server.mjs'));
  await copyFile(join(ROOT, 'electron', 'genkey.cjs'), join(OUT, 'genkey.cjs'));

  const isrc = join(ROOT, 'dist', 'integrity.json');
  if (existsSync(isrc)) {
    await mkdir(join(OUT, 'dist'), { recursive: true });
    await copyFile(isrc, join(OUT, 'dist', 'integrity.json'));
  }
  await mkdir(join(OUT, 'data'), { recursive: true });

  await writeFile(join(OUT, '.env.example'), bat([
    'GAME_SERVER_SECRET=your-32-char-random-secret-here',
    '# Optional: DEEPSEEK_API_KEY=sk-xxx',
  ]));

  await writeFile(join(OUT, 'start.bat'), bat([
    '@echo off',
    'setlocal enabledelayedexpansion',
    'title Humans are Cats Investigation - Server',
    'echo ========================================',
    'echo  Humans are Cats: Investigation Server',
    'echo ========================================',
    'echo.',
    'if not exist .env (',
    '  if "%GAME_SERVER_SECRET%"=="" (',
    '    echo [FIRST RUN] Generating secret key...',
    '    for /f "delims=" %%i in (\'node genkey.cjs\') do set KEY=%%i',
    '    if "!KEY!"=="" (',
    '      echo [ERROR] Failed. Create .env manually from .env.example',
    '      pause',
    '      exit /b 1',
    '    )',
    '    echo GAME_SERVER_SECRET=!KEY!> .env',
    '    echo [OK] Secret saved to .env',
    '  ) else (',
    '    echo GAME_SERVER_SECRET=%GAME_SERVER_SECRET%> .env',
    '  )',
    '  echo.',
    ')',
    'echo Starting on http://localhost:3000',
    'echo Press Ctrl+C to stop',
    'echo.',
    'node server.mjs',
    'pause',
  ]));

  await writeFile(join(OUT, 'start.sh'), sh([
    '#!/bin/bash',
    'echo "Humans are Cats: Investigation Server"',
    'if [ ! -f .env ] && [ -z "$GAME_SERVER_SECRET" ]; then',
    '  echo "[FIRST RUN] Generating secret key..."',
    '  KEY=$(node genkey.cjs)',
    '  echo "GAME_SERVER_SECRET=$KEY" > .env',
    '  echo "[OK] Saved to .env"',
    'fi',
    'echo "Starting on http://localhost:3000"',
    'node server.mjs',
  ]));

  await writeFile(join(OUT, 'README.txt'), [
    'Humans are Cats: Investigation - Server',
    '========================================',
    'Requirements: Node.js 18+',
    'Quick Start: double-click start.bat',
    '.env auto-generated on first run.',
    'Server: http://localhost:3000',
  ].join(CRLF));

  console.log('[server-pack] Done!');
};

main().catch(err => { console.error(err); process.exit(1); });
