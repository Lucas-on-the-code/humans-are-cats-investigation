const raw = (import.meta.env.VITE_API_BASE || '');
export const API_BASE: string = raw.endsWith('/') ? raw.slice(0, -1) : raw;

export function apiUrl(path: string): string {
  return API_BASE + path;
}
