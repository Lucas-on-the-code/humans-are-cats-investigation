/**
 * API base URL — empty string in browser dev (uses relative paths proxied by Vite).
 * Set VITE_API_BASE in production builds or Electron packaging to point to the remote server.
 *
 * Examples:
 *   .env.development  → VITE_API_BASE=            (empty → relative, proxied by Vite dev server)
 *   .env.production   → VITE_API_BASE=https://cats.renchengzhang.com
 *   Electron build    → VITE_API_BASE=https://cats.renchengzhang.com
 */

export const API_BASE: string = import.meta.env.VITE_API_BASE || '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
