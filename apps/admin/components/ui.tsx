'use client';
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';
import { ApiError } from '@/lib/api';

export function Page({ title, actions, children, lead }: { title: string; lead?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {lead ? <p className="lead">{lead}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card">
      {title || actions ? <div className="card-head"><h2>{title}</h2>{actions}</div> : null}
      {children}
    </div>
  );
}

export function Button({ variant = 'default', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return <button {...p} className={`btn btn-${variant} ${p.className ?? ''}`} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ''}`} />;

const TONE: Record<string, string> = {
  open: 'ok', posted: 'ok', approved: 'ok', true: 'ok', active: 'ok',
  soft: 'warn', pending: 'warn',
  hard: 'muted', sealed: 'seal', rejected: 'bad', false: 'bad', inactive: 'muted',
};
export function Badge({ value, label }: { value: string | boolean; label?: string }) {
  const v = String(value);
  return <span className={`badge badge-${TONE[v] ?? 'muted'}`}>{label ?? v}</span>;
}

/** Shows the ledger's refusal code prominently: it is the reason, word for word. */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="error" role="alert">
      {e.code ? <code>{e.code}</code> : null} {e.message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Loading() {
  return <p className="empty">Loading…</p>;
}

export const short = (id?: string | null) => (id ? id.slice(0, 8) : '—');
