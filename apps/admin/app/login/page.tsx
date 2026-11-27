'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { supabaseMode, signInWithPassword, verifyTotp, setDevToken } from '@/lib/auth';
import { useAction } from '@/lib/api';
import { Button, ErrorNote, Field, Input } from '@/components/ui';

export default function Login() {
  const router = useRouter();
  const act = useAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [token, setToken] = useState('');

  if (!supabaseMode) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>Ledger admin</h1>
          <p className="muted">
            Development sign-in. Supabase Auth is not configured, so paste an access token minted with
            <code> npm run dev:token</code> (it needs the API&apos;s JWT secret). The API verifies it.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); setDevToken(token); router.replace('/'); }}>
            <Field label="Access token"><textarea className="input" value={token} onChange={(e) => setToken(e.target.value)} required /></Field>
            <Button variant="primary" disabled={!token.trim()}>Sign in</Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="login-card">
        <h1>Ledger admin</h1>
        <p className="muted">Sign in with your password, then your authenticator app. Both are required.</p>
        {step === 'password' ? (
          <form onSubmit={(e) => { e.preventDefault(); act.run(async () => {
            const r = await signInWithPassword(email, password);
            if (r.needsMfa) setStep('mfa'); else router.replace('/');
          }); }}>
            <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            <ErrorNote error={act.error} />
            <Button variant="primary" disabled={act.busy}>Continue</Button>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); act.run(async () => { await verifyTotp(code); router.replace('/'); }); }}>
            <Field label="6-digit code"><Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
            <ErrorNote error={act.error} />
            <Button variant="primary" disabled={act.busy}>Verify</Button>
          </form>
        )}
      </div>
    </div>
  );
}
