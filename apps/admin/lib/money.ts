// Money in the console: decimal.js only, never JS number arithmetic (rule 4).
import { Decimal } from 'decimal.js';

export const D = (v: unknown) => {
  try {
    return new Decimal(v === null || v === undefined || v === '' ? 0 : String(v));
  } catch {
    return new Decimal(NaN);
  }
};

export const isAmount = (s: string) => /^\d+(\.\d{1,4})?$/.test(s.trim());

/** 12,345.60 style, keeping 2 decimals unless more are significant (up to 4). */
export function fmt(v: unknown): string {
  const d = D(v);
  if (d.isNaN()) return '—';
  const dp = Math.max(2, Math.min(4, d.decimalPlaces()));
  const [i, f] = d.abs().toFixed(dp).split('.');
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
  return d.isNeg() ? `(${s})` : s;
}

export const sum = (xs: unknown[]) => xs.reduce<Decimal>((a, x) => a.plus(D(x)), new Decimal(0));
