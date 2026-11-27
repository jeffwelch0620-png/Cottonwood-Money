'use client';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { D, fmt } from '@/lib/money';
import { Badge, Card, Empty, ErrorNote, Field, Input, Loading, Page, Select } from '@/components/ui';

type Tab = 'pl' | 'bs' | 'tb' | 'tie';
const TABS: [Tab, string][] = [['pl', 'Profit & loss'], ['bs', 'Balance sheet'], ['tb', 'Trial balance'], ['tie', 'Cash/accrual tie-out']];

export default function Reports() {
  const { entity } = useSession();
  const locations = useApi<any[]>('/v1/locations');
  const [tab, setTab] = useState<Tab>('pl');
  const [basis, setBasis] = useState<'accrual' | 'cash' | ''>('');
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [loc, setLoc] = useState('');
  useEffect(() => { setBasis(''); setLoc(''); }, [entity?.id]);
  const effBasis = basis || entity?.default_basis || 'accrual';
  const qs = (o: Record<string, string>) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v))).toString();
  const path = !entity ? null
    : tab === 'pl' ? `/v1/reports/profit-and-loss?${qs({ entity_id: entity.id, from, to, basis: effBasis, location_id: loc })}`
    : tab === 'bs' ? `/v1/reports/balance-sheet?${qs({ entity_id: entity.id, as_of: to, basis: effBasis })}`
    : tab === 'tb' ? `/v1/reports/trial-balance?${qs({ entity_id: entity.id, from, to, basis: effBasis })}`
    : `/v1/reports/tie-out?${qs({ entity_id: entity.id, from, to })}`;
  const r = useApi<any>(path);

  return (
    <Page title="Reports" lead="One set of books: accrual is stored, cash is computed from payment links. Every report prints its basis.">
      <Card>
        <div className="row">
          <div className="segmented" role="tablist">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          {tab !== 'tie' ? (
            <div className="segmented" aria-label="Basis">
              {(['accrual', 'cash'] as const).map((b) => <button key={b} className={effBasis === b ? 'on' : ''} onClick={() => setBasis(b)}>{b === 'accrual' ? 'Accrual' : 'Cash'}</button>)}
            </div>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {tab !== 'bs' ? <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field> : null}
          <Field label={tab === 'bs' ? 'As of' : 'To'}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          {tab === 'pl' ? (
            <Field label="Location">
              <Select value={loc} onChange={(e) => setLoc(e.target.value)}>
                <option value="">All locations</option>
                {(locations.data ?? []).filter((l) => l.entity_id === entity?.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
          ) : null}
        </div>
      </Card>
      {!entity ? <Empty>Choose an entity.</Empty> : r.loading ? <Loading /> : r.error ? <ErrorNote error={r.error} /> : r.data ? (
        <Card title={`${TABS.find(([k]) => k === tab)![1]} — ${entity.legal_name}`} actions={tab !== 'tie' ? <Badge value="active" label={`${r.data.basis ?? effBasis} basis`} /> : null}>
          {tab === 'pl' ? <PL d={r.data} /> : tab === 'bs' ? <BS d={r.data} /> : tab === 'tb' ? <TB d={r.data} /> : <Tie d={r.data} />}
        </Card>
      ) : null}
    </Page>
  );
}

function PL({ d }: { d: any }) {
  const sec = (type: string) => d.lines.filter((l: any) => l.type === type);
  return (
    <table>
      <tbody>
        <tr><th colSpan={2}>Revenue</th></tr>
        {sec('revenue').map((l: any) => <tr key={l.number}><td>{l.number} {l.name}</td><td className="num">{fmt(l.amount)}</td></tr>)}
        <tr><td><strong>Total revenue</strong></td><td className="num"><strong>{fmt(d.revenue)}</strong></td></tr>
        <tr><th colSpan={2}>Expenses</th></tr>
        {sec('expense').map((l: any) => <tr key={l.number}><td>{l.number} {l.name}</td><td className="num">{fmt(l.amount)}</td></tr>)}
        <tr><td><strong>Total expenses</strong></td><td className="num"><strong>{fmt(d.expense)}</strong></td></tr>
      </tbody>
      <tfoot><tr><td>Net income</td><td className="num">{fmt(d.netIncome)}</td></tr></tfoot>
    </table>
  );
}

function BS({ d }: { d: any }) {
  const sec = (s: string) => d.lines.filter((l: any) => l.section === s);
  const rows = (s: string) => sec(s).map((l: any, i: number) => <tr key={s + i}><td>{l.number ? `${l.number} ` : ''}{l.name}</td><td className="num">{fmt(l.amount)}</td></tr>);
  return (
    <>
      <p className={`check ${d.balanced ? 'ok' : 'bad'}`}>{d.balanced ? '✓ Assets = liabilities + equity' : '✗ Does not balance'}</p>
      <table>
        <tbody>
          <tr><th colSpan={2}>Assets</th></tr>{rows('asset')}
          <tr><td><strong>Total assets</strong></td><td className="num"><strong>{fmt(d.assets)}</strong></td></tr>
          <tr><th colSpan={2}>Liabilities</th></tr>{rows('liability')}
          <tr><td><strong>Total liabilities</strong></td><td className="num"><strong>{fmt(d.liabilities)}</strong></td></tr>
          <tr><th colSpan={2}>Equity</th></tr>{rows('equity')}
          <tr><td><strong>Total equity</strong></td><td className="num"><strong>{fmt(d.equity)}</strong></td></tr>
        </tbody>
        <tfoot><tr><td>Liabilities + equity</td><td className="num">{fmt(D(d.liabilities).plus(D(d.equity)))}</td></tr></tfoot>
      </table>
    </>
  );
}

function TB({ d }: { d: any }) {
  return (
    <>
      <p className={`check ${d.balanced ? 'ok' : 'bad'}`}>{d.balanced ? '✓ Debits = credits; balances net to zero' : '✗ Out of balance'}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Account</th><th className="num">Opening</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Closing</th></tr></thead>
          <tbody>{d.lines.map((l: any) => (
            <tr key={l.number}><td>{l.number} {l.name}</td><td className="num">{fmt(l.opening)}</td><td className="num">{fmt(l.debits)}</td><td className="num">{fmt(l.credits)}</td><td className="num">{fmt(l.closing)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td>Totals</td><td /><td className="num">{fmt(d.totals.debits)}</td><td className="num">{fmt(d.totals.credits)}</td><td className="num">{fmt(d.totals.closing)}</td></tr></tfoot>
        </table>
      </div>
    </>
  );
}

function Tie({ d }: { d: any }) {
  const ok = D(d.difference).isZero();
  return (
    <>
      <p className={`check ${ok ? 'ok' : 'bad'}`}>{ok ? '✓ Cash and accrual reconcile to the cent' : `✗ Difference ${fmt(d.difference)}`}</p>
      <table>
        <tbody>
          <tr><td>Net income, accrual</td><td className="num">{fmt(d.niAccrual)}</td></tr>
          <tr><td>− change in AR, AP, prepaids, accruals, deferred revenue (accrual)</td><td className="num">{fmt(D(d.wcChangeAccrual).neg())}</td></tr>
          <tr><td>+ same accounts on the cash basis (unapplied cash)</td><td className="num">{fmt(d.wcChangeCash)}</td></tr>
          <tr><td><strong>Expected net income, cash</strong></td><td className="num"><strong>{fmt(d.expectedNiCash)}</strong></td></tr>
          <tr><td>Net income, cash (line by line)</td><td className="num">{fmt(d.niCash)}</td></tr>
        </tbody>
        <tfoot><tr><td>Difference</td><td className="num">{fmt(d.difference)}</td></tr></tfoot>
      </table>
      {Object.keys(d.detail ?? {}).length ? (
        <>
          <h2 style={{ marginTop: 16 }}>Working-capital accounts (movement, debit-positive)</h2>
          <table>
            <thead><tr><th>Account</th><th className="num">Accrual</th><th className="num">Cash basis</th></tr></thead>
            <tbody>{Object.entries(d.detail).map(([n, v]: [string, any]) => <tr key={n}><td>{n} {v.name}</td><td className="num">{fmt(v.accrual)}</td><td className="num">{fmt(v.cash)}</td></tr>)}</tbody>
          </table>
        </>
      ) : null}
    </>
  );
}
