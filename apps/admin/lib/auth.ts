'use client';
// Session token for API calls.
//   Supabase mode (NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY set): email/password,
//   then a TOTP MFA challenge, so the access token carries aal2. The tenant_id claim comes from the
//   project's custom access token hook.
//   Dev mode (no Supabase configured): paste a token minted by `npm run dev:token` on a machine
//   that holds the API's JWT secret. The API verifies every token either way.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const DEV_KEY = 'ledger.devToken';

let client: SupabaseClient | null = null;
export const supabaseMode = Boolean(URL_ && ANON);
export function supabase(): SupabaseClient {
  if (!supabaseMode) throw new Error('Supabase is not configured');
  client ??= createClient(URL_!, ANON!, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

export async function getToken(): Promise<string | null> {
  if (supabaseMode) {
    const { data } = await supabase().auth.getSession();
    return data.session?.access_token ?? null;
  }
  try {
    return sessionStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

export function setDevToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(DEV_KEY, token.trim());
    else sessionStorage.removeItem(DEV_KEY);
  } catch {
    /* storage unavailable: token lives only for this page */
  }
}

export async function signOut() {
  if (supabaseMode) await supabase().auth.signOut();
  setDevToken(null);
}

/** Supabase: password step. Returns whether an MFA step is needed to reach aal2. */
export async function signInWithPassword(email: string, password: string): Promise<{ needsMfa: boolean }> {
  const sb = supabase();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  return { needsMfa: data?.currentLevel !== 'aal2' };
}

/** Supabase: TOTP step. */
export async function verifyTotp(code: string) {
  const sb = supabase();
  const { data: factors, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  const totp = factors.totp.find((f) => f.status === 'verified');
  if (!totp) throw new Error('No verified authenticator app on this account. Enroll one first.');
  const res = await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
  if (res.error) throw res.error;
}

/** Refresh after creating a tenant so the hook can add the tenant claim. */
export async function refreshSession() {
  if (supabaseMode) await supabase().auth.refreshSession();
}

/** Reads (without verifying — the API does that) the claims, for display only. */
export function peekClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return null;
  }
}
