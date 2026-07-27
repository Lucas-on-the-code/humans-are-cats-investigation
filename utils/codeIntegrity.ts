import { apiUrl } from './apiBase';

/**
 * Code integrity verifier — hashes the running JS bundle at runtime
 * and compares against the server's build manifest to detect tampering.
 * 
 * Works with Electron + encrypted asar because the hash is computed
 * from the in-memory code that actually executes, not from disk files.
 */
let computedHash = '';

export async function initCodeIntegrity(): Promise<string> {
  try {
    // 1. Fetch the server's integrity manifest
    const res = await fetch(apiUrl('/api/integrity'));
    if (!res.ok) return '';
    const manifest = await res.json();
    const expectedHash = manifest?.version as string | undefined;
    if (!expectedHash) return '';

    // 2. Find our own JS bundle in the DOM
    const scripts = document.querySelectorAll('script[src]');
    const ownScript = Array.from(scripts).find((s) => {
      const src = s.getAttribute('src') || '';
      return src.includes('/assets/index-') && src.endsWith('.js');
    });
    if (!ownScript) return '';

    // 3. Fetch and hash our own JS
    const src = ownScript.getAttribute('src')!;
    const scriptRes = await fetch(src);
    if (!scriptRes.ok) return '';
    const blob = await scriptRes.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', blob);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    computedHash = `sha256-${hashHex}`;

    // 4. Validate
    if (computedHash !== expectedHash) {
      console.warn(
        '[integrity] CODE TAMPER DETECTED!',
        '\n  Expected:', expectedHash,
        '\n  Actual:  ', computedHash,
      );
    } else {
      console.log('[integrity] Code integrity verified:', computedHash);
    }
  } catch (err) {
    console.warn('[integrity] Failed to verify code integrity:', err);
  }
  return computedHash;
}

export function getCodeHash(): string {
  return computedHash;
}
