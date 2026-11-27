'use client';
// Thin client for the 8a API. Errors carry the database's refusal code (SELF_APPROVAL, LAST_OWNER, ...)
// so screens show exactly what the ledger said.
import { useCallback, useEffect, useState } from 'react';
import { getToken } from './auth';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body (exports) */ }
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'HTTP_' + res.status, data?.message ?? res.statusText);
  return data as T;
}

/** Raw fetch for downloads: returns body text and headers. */
export async function apiRaw(path: string): Promise<{ body: string; headers: Headers }> {
  const token = await getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  const body = await res.text();
  if (!res.ok) {
    let d: any = {};
    try { d = JSON.parse(body); } catch { /* ignore */ }
    throw new ApiError(res.status, d.code ?? 'HTTP_' + res.status, d.message ?? res.statusText);
  }
  return { body, headers: res.headers };
}

/** GET with loading/error state; `reload()` refetches. `path = null` skips. */
export function useApi<T = any>(path: string | null) {
  // Results are keyed by the path that produced them, so a screen never renders one request's
  // data under another's shape (e.g. right after switching report tabs).
  const [state, setState] = useState<{ path: string | null; data: T | null; error: ApiError | Error | null }>({ path: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>('GET', path)
      .then((d) => { if (live) setState({ path, data: d, error: null }); })
      .catch((e) => { if (live) setState({ path, data: null, error: e }); });
    return () => { live = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = path !== null && state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: path !== null && !current, reload };
}

/** Runs a mutation, tracking busy/error; returns true on success. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}
