// Money is never a JavaScript number. Decimal in TypeScript, NUMERIC(19,4) in Postgres.
import { Decimal } from 'decimal.js';

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

export type Money = Decimal;

export const money = (v: Decimal.Value): Money => new Decimal(v);

/** Fixed 4-decimal string, the form sent to and returned by the database. */
export const toDb = (m: Money): string => m.toFixed(4);

export const hasAtMost4Decimals = (m: Money): boolean => m.decimalPlaces() <= 4;

export const sum = (xs: Money[]): Money => xs.reduce((a, b) => a.plus(b), new Decimal(0));
