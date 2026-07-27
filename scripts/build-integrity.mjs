import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PUBLIC = join(ROOT, 'public');

const hashFile = async (filePath) => {
  const data = await readFile(filePath);
  const hash = createHash('sha256').update(data).digest('hex');
  return { path: filePath, hash: `sha256-${hash}` };
};

const findJsBundle = async () => {
  const assetsDir = join(DIST, 'assets');
  const files = await readdir(assetsDir);
  const bundle = files.find((name) => name.startsWith('index-') && name.endsWith('.js'));
  if (!bundle) throw new Error('No index JS bundle found in dist/assets');
  return join(assetsDir, bundle);
};

const main = async () => {
  console.log('[integrity] Hashing build artifacts...');

  const jsBundle = await findJsBundle();
  const wasmFile = join(PUBLIC, 'wasm', 'game_state_core_bg.wasm');

  const jsResult = await hashFile(jsBundle);
  const wasmResult = await hashFile(wasmFile);

  // Shorten paths to relative
  const jsRel = jsBundle.replace(ROOT, '').replace(/^[/\\]/, '');
  const wasmRel = wasmFile.replace(ROOT, '').replace(/^[/\\]/, '');

  const manifest = {
    version: jsResult.hash,
    builtAt: new Date().toISOString(),
    files: {
      [jsRel]: jsResult.hash,
      [wasmRel]: wasmResult.hash,
    },
  };

  const outPath = join(DIST, 'integrity.json');
  await writeFile(outPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[integrity] Wrote ${outPath}`);
  console.log(`[integrity]   JS:   ${jsResult.hash}`);
  console.log(`[integrity]   WASM: ${wasmResult.hash}`);
};

main().catch((err) => {
  console.error('[integrity] Failed:', err);
  process.exit(1);
});
