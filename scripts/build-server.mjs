import { mkdir, copyFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'server-dist');

const copyDir = async (src, dest) => {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const s = await stat(srcPath);
    if (s.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
};

const main = async () => {
  console.log('[server-pack] Building server distribution...');

  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });

  // Copy server code
  await copyDir(join(ROOT, 'server'), join(OUT, 'server'));
  await copyFile(join(ROOT, 'server.mjs'), join(OUT, 'server.mjs'));

  // Copy integrity manifest
  const integritySrc = join(ROOT, 'dist', 'integrity.json');
  if (existsSync(integritySrc)) {
    await mkdir(join(OUT, 'dist'), { recursive: true });
    await copyFile(integritySrc, join(OUT, 'dist', 'integrity.json'));
  }

  // Create data directory
  await mkdir(join(OUT, 'data'), { recursive: true });

  // .env template
  await writeFile(join(OUT, '.env.example'),
    '# Generate a secret: node -e "console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))"\r\n' +
    'GAME_SERVER_SECRET=your-32-char-random-secret-here\r\n' +
    '\r\n' +
    '# Optional: DeepSeek API for Miku NPC chat\r\n' +
    '# DEEPSEEK_API_KEY=sk-xxx\r\n'
  );

  // Windows: start.bat (auto-creates .env on first run)
  await writeFile(join(OUT, 'start.bat'),
    '@echo off\r\n' +
    'title Humans are Cats Investigation - Server\r\n' +
    'echo ========================================\r\n' +
    'echo  Humans are Cats: Investigation\r\n' +
    'echo  Server v0.0.0\r\n' +
    'echo ========================================\r\n' +
    'echo.\r\n' +
    'if not exist .env (\r\n' +
    '  if "%GAME_SERVER_SECRET%"=="" (\r\n' +
    '    echo [FIRST RUN] No secret key found.\r\n' +
    '    echo.\r\n' +
    '    echo Generating one for you...\r\n' +
    '    for /f %%i in (\'node -e "console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))"\') do set KEY=%%i\r\n' +
    '    echo GAME_SERVER_SECRET=!KEY!> .env\r\n' +
    '    echo.\r\n' +
    '    echo [OK] Auto-generated secret and saved to .env\r\n' +
    '  ) else (\r\n' +
    '    echo GAME_SERVER_SECRET=%GAME_SERVER_SECRET%> .env\r\n' +
    '  )\r\n' +
    '  echo.\r\n' +
    ')\r\n' +
    'echo Starting on http://localhost:3000\r\n' +
    'echo Press Ctrl+C to stop\r\n' +
    'echo.\r\n' +
    'node server.mjs\r\n' +
    'pause\r\n'
  );

  // Linux/Mac: start.sh
  await writeFile(join(OUT, 'start.sh'),
    '#!/bin/bash\n' +
    'echo "========================================"\n' +
    'echo " Humans are Cats: Investigation"\n' +
    'echo " Server v0.0.0"\n' +
    'echo "========================================"\n' +
    'echo ""\n' +
    'if [ ! -f .env ] && [ -z "$GAME_SERVER_SECRET" ]; then\n' +
    '  echo "[FIRST RUN] Generating secret key..."\n' +
    '  KEY=$(node -e "console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))")\n' +
    '  echo "GAME_SERVER_SECRET=$KEY" > .env\n' +
    '  echo "[OK] Auto-generated secret and saved to .env"\n' +
    '  echo ""\n' +
    'fi\n' +
    'echo "Starting on http://localhost:3000"\n' +
    'node server.mjs\n'
  );

  // README
  await writeFile(join(OUT, 'README.txt'),
    'Humans are Cats: Investigation - Server\r\n' +
    '========================================\r\n' +
    '\r\n' +
    'Requirements: Node.js 18+ (no npm install needed)\r\n' +
    '\r\n' +
    'Quick Start:\r\n' +
    '  Windows: double-click start.bat\r\n' +
    '  Linux:   chmod +x start.sh && ./start.sh\r\n' +
    '\r\n' +
    'First run auto-generates a secret key in .env.\r\n' +
    'Server runs on http://localhost:3000\r\n' +
    '\r\n' +
    'Files:\r\n' +
    '  .env          - Secret key (auto-generated on first run)\r\n' +
    '  .env.example  - Template with all options\r\n' +
    '  data/         - User database, leaderboard, scores\r\n' +
    '  start.bat/sh  - Launch scripts\r\n'
  );

  console.log('[server-pack] Done! Output: server-dist/');
};

main().catch(err => { console.error('[server-pack] Failed:', err); process.exit(1); });
