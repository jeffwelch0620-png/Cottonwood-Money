'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { getToken, signOut, refreshSession, peekClaims } from '@/lib/auth';
import { api, useAction } from '@/lib/api';
import { SessionProvider, useSession } from '@/lib/session';
import { Button, ErrorNote, Field, Input } from './ui';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/journal', label: 'Journal' },
  { href: '/reports', label: 'Reports' },
  { href: '/periods', label: 'Periods' },
  { href: '/accounts', label: 'Chart of accounts' },
  { href: '/entities', label: 'Entities' },
  { href: '/members', label: 'Members' },
  { href: '/audit', label: 'Audit' },
];

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getToken().then((t) => (t ? setReady(true) : router.replace('/login')));
  }, [router]);
  if (!ready) return null;
  return (
    <SessionProvider>
      <Frame>{children}</Frame>
    </SessionProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { me, meError, meLoading, entities, entity, setEntityId } = useSession();
  const path = usePathname();
  const router = useRouter();
  const logout = async () => { await signOut(); router.replace('/login'); };

  if (meLoading && !me) return <div className="center-note">Loading…</div>;
  if (!me) return <NoTenant error={meError} onSignOut={logout} />;

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" aria-hidden>≡</span>
          <div>
            <div className="brand-name">{me.tenant_name}</div>
            <div className="brand-sub">Ledger admin</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`nav-link ${(n.href === '/' ? path === '/' : path.startsWith(n.href)) ? 'active' : ''}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who">
            <div>{me.principal_name}</div>
            <div className="muted small">{me.role}{me.location_ids ? ' · location-scoped' : ''}</div>
          </div>
          <Button variant="ghost" onClick={logout}>Sign out</Button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <label className="entity-pick">
            <span className="muted small">Entity</span>
            <select className="input" value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)} disabled={!entities.length}>
              {entities.length ? entities.map((e) => <option key={e.id} value={e.id}>{e.legal_name}</option>) : <option>No entities yet</option>}
            </select>
          </label>
          {entity ? <span className="muted small">{calendarLabel(entity.fiscal_calendar)} · default basis {entity.default_basis}</span> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export const calendarLabel = (c: string) => ({ calendar_month: 'Calendar months', '445': '4-4-5 weeks', '13_period': '13 periods' }[c] ?? c);

/** Signed in, but the token has no verified tenant membership: sign up (create a tenant) or explain. */
function NoTenant({ error, onSignOut }: { error: Error | null; onSignOut: () => void }) {
  const [name, setName] = useState('');
  const [display, setDisplay] = useState('');
  const act = useAction();
  const [created, setCreated] = useState<string | null>(null);
  const [claims, setClaims] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { getToken().then((t) => setClaims(peekClaims(t))); }, []);
  return (
    <div className="login">
      <div className="login-card">
        <h1>No tenant for this session</h1>
        <p className="muted">
          The API found no active, MFA-verified membership matching this token
          {claims?.tenant_id ? <> for tenant <code>{String(claims.tenant_id).slice(0, 8)}</code></> : ' (the token has no tenant claim)'}
          {claims?.aal && claims.aal !== 'aal2' ? '. Your sign-in has not completed MFA' : ''}.
        </p>
        <ErrorNote error={error && (error as { code?: string }).code !== 'NOT_AUTHENTICATED' ? error : null} />
        {created ? (
          <p>Created tenant <code>{created.slice(0, 8)}</code>. Refresh your session so your token carries it, then reload.</p>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); act.run(async () => {
            const r = await api<{ tenant_id: string }>('POST', '/v1/tenants', { name, display_name: display || undefined });
            setCreated(r.tenant_id);
            await refreshSession();
          }); }}>
            <h2>Start a new restaurant group</h2>
            <Field label="Group name"><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            <Field label="Your name"><Input value={display} onChange={(e) => setDisplay(e.target.value)} /></Field>
            <ErrorNote error={act.error} />
            <Button variant="primary" disabled={act.busy || !name}>Create tenant</Button>
          </form>
        )}
        <p><Button variant="ghost" onClick={onSignOut}>Sign out</Button> <Button variant="ghost" onClick={() => location.reload()}>Reload</Button></p>
      </div>
    </div>
  );
}
