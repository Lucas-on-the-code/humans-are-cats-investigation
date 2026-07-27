import { mkdir, copyFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
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

  // Clean output
  if (existsSync(OUT)) {
    await rm(OUT);
  }

  // Copy server code
  await copyDir(join(ROOT, 'server'), join(OUT, 'server'));

  // Copy main entry
  await copyFile(join(ROOT, 'server.mjs'), join(OUT, 'server.mjs'));

  // Copy integrity manifest (required for code hash validation)
  const integritySrc = join(ROOT, 'dist', 'integrity.json');
  if (existsSync(integritySrc)) {
    await mkdir(join(OUT, 'dist'), { recursive: true });
    await copyFile(integritySrc, join(OUT, 'dist', 'integrity.json'));
  }

  // Create data directory placeholder
  await mkdir(join(OUT, 'data'), { recursive: true });
  await writeFile(join(OUT, 'data', '.gitkeep'), '');

  // Windows start script
  await writeFile(join(OUT, 'start.bat'),
    '@echo off\r\n' +
    'echo Humans are Cats: Investigation - Server\r\n' +
    'echo.\r\n' +
    'if "%GAME_SERVER_SECRET%"=="" (\r\n' +
    '  echo [ERROR] GAME_SERVER_SECRET not set!\r\n' +
    '  echo Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\r\n' +
    '  echo Then run: set GAME_SERVER_SECRET=your-secret-here\r\n' +
    '  echo.\r\n' +
    '  pause\r\n' +
    '  exit /b 1\r\n' +
    ')\r\n' +
    'echo Server starting on http://localhost:3000\r\n' +
    'echo Log: data/game-auth-db.json\r\n' +
    'echo.\r\n' +
    'node server.mjs\r\n' +
    'pause\r\n'
  );

  // Linux/Mac start script
  await writeFile(join(OUT, 'start.sh'),
    '#!/bin/bash\n' +
    'echo "Humans are Cats: Investigation - Server"\n' +
    'echo ""\n' +
    'if [ -z "$GAME_SERVER_SECRET" ]; then\n' +
    '  echo "[ERROR] GAME_SERVER_SECRET not set!"\n' +
    '  echo "Generate one with: node -e \\"console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))\\""\n' +
    '  echo "Then run: export GAME_SERVER_SECRET=your-secret-here"\n' +
    '  exit 1\n' +
    'fi\n' +
    'echo "Server starting on http://localhost:3000"\n' +
    'node server.mjs\n'
  );

  // README
  await writeFile(join(OUT, 'README.txt'),
    'Humans are Cats: Investigation - Server\r\n' +
    '========================================\r\n' +
    '\r\n' +
    'Requirements: Node.js 18+\r\n' +
    '\r\n' +
    'Quick Start:\r\n' +
    '  1. Generate a secret key:\r\n' +
    '     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\r\n' +
    '\r\n' +
    '  2. Set environment variables:\r\n' +
    '     Windows: set GAME_SERVER_SECRET=your-secret-here\r\n' +
    '     Linux:   export GAME_SERVER_SECRET=your-secret-here\r\n' +
    '\r\n' +
    '  3. (Optional) DeepSeek API for Miku NPC chat:\r\n' +
    '     set DEEPSEEK_API_KEY=sk-xxx\r\n' +
    '\r\n' +
    '  4. Start:\r\n' +
    '     Windows: start.bat\r\n' +
    '     Linux:   chmod +x start.sh && ./start.sh\r\n' +
    '\r\n' +
    '  5. Server runs on http://localhost:3000\r\n' +
    '\r\n' +
    'Data:\r\n' +
    '  - Users / leaderboard / scores stored in data/game-auth-db.json\r\n' +
    '  - Miku NPC memories stored in the same database\r\n' +
    '\r\n' +
    'Environment Variables:\r\n' +
    '  GAME_SERVER_SECRET  (required) - HMAC signing key, >= 32 chars\r\n' +
    '  DEEPSEEK_API_KEY    (optional) - DeepSeek API key for Miku chat\r\n' +
    '  DEEPSEEK_MODEL      (optional) - default: deepseek-v4-flash\r\n' +
    '  PORT                (optional) - default: 3000\r\n' +
    '  HOST                (optional) - default: 0.0.0.0\r\n' +
    '  TRUSTED_PROXY_HOPS  (optional) - set if behind nginx/Caddy\r\n'
  );

  console.log('[server-pack] Done! Output: server-dist/');
  console.log('[server-pack]   server.mjs       - Entry point');
  console.log('[server-pack]   server/          - API logic');
  console.log('[server-pack]   dist/            - Integrity manifest');
  console.log('[server-pack]   data/            - Database (empty, created at runtime)');
  console.log('[server-pack]   start.bat / .sh  - Launch scripts');
};

async function rm(dir) {
  const { rm: rmNode } = await import('node:fs/promises');
  await rmNode(dir, { recursive: true, force: true });
}

main().catch(err => { console.error('[server-pack] Failed:', err); process.exit(1); });
