'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { D, fmt, isAmount, sum } from '@/lib/money';
import { Button, Card, ErrorNote, Field, Input, Page, Select } from '@/components/ui';

interface Line { account_id: string; location_id: string; debit: string; credit: string }
const blank = (loc = ''): Line => ({ account_id: '', location_id: loc, debit: '', credit: '' });

export default function NewEntry() {
  const { entity } = useSession();
  const router = useRouter();
  const accounts = useApi<any[]>('/v1/accounts');
  const locations = useApi<any[]>('/v1/locations');
  const locs = (locations.data ?? []).filter((l) => l.entity_id === entity?.id);
  const accts = (accounts.data ?? []).filter((a) => a.active && !a.is_intercompany);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState('manual');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const act = useAction();

  const set = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v, ...(k === 'debit' && v ? { credit: '' } : k === 'credit' && v ? { debit: '' } : {}) } : l)));
  const dr = sum(lines.map((l) => (isAmount(l.debit) ? l.debit : 0)));
  const cr = sum(lines.map((l) => (isAmount(l.credit) ? l.credit : 0)));
  const badAmount = lines.some((l) => (l.debit && !isAmount(l.debit)) || (l.credit && !isAmount(l.credit)));
  const complete = lines.every((l) => l.account_id && (l.location_id || locs.length === 1) && (l.debit || l.credit));
  const balanced = dr.eq(cr) && dr.gt(0);

  return (
    <Page title="New journal entry" lead="Saved as a draft. A different person approves it in Approvals; only then is it posted. Manual entries need no source document; other types do (attach via the API for now).">
      <Card>
        <div className="row">
          <Field label="Entity"><Input value={entity?.legal_name ?? ''} disabled /></Field>
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Type">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="manual">Manual adjustment</option>
              <option value="opening">Opening balance</option>
            </Select>
          </Field>
        </div>
        <Field label="Memo"><Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Why this entry is needed" /></Field>
        <div className="table-wrap">
          <table>
            <thead><tr><th style={{ width: '40%' }}>Account</th><th>Location</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={i}>
                <td><Select value={l.account_id} onChange={(e) => set(i, 'account_id', e.target.value)} style={{ width: '100%' }} aria-label={`Account line ${i + 1}`}>
                  <option value="">Choose…</option>
                  {accts.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
                </Select></td>
                <td><Select value={l.location_id || (locs.length === 1 ? locs[0].id : '')} onChange={(e) => set(i, 'location_id', e.target.value)} aria-label={`Location line ${i + 1}`}>
                  <option value="">Choose…</option>
                  {locs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select></td>
                <td><Input className="num" inputMode="decimal" value={l.debit} onChange={(e) => set(i, 'debit', e.target.value)} aria-label={`Debit line ${i + 1}`} /></td>
                <td><Input className="num" inputMode="decimal" value={l.credit} onChange={(e) => set(i, 'credit', e.target.value)} aria-label={`Credit line ${i + 1}`} /></td>
                <td>{lines.length > 2 ? <Button variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</Button> : null}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr>
              <td colSpan={2}><Button onClick={() => setLines((ls) => [...ls, blank(locs.length === 1 ? locs[0].id : '')])}>Add line</Button></td>
              <td className="num">{fmt(dr)}</td><td className="num">{fmt(cr)}</td><td />
            </tr></tfoot>
          </table>
        </div>
        <p className={balanced ? 'check ok' : 'check bad'}>
          {badAmount ? 'Amounts must be positive with at most 4 decimal places.' : balanced ? 'Balanced.' : `Out of balance by ${fmt(dr.minus(cr).abs())}.`}
        </p>
        <ErrorNote error={act.error} />
        <Button variant="primary" disabled={!entity || !balanced || !complete || badAmount || act.busy}
          onClick={() => act.run(async () => {
            await api('POST', '/v1/drafts', {
              entity_id: entity!.id, entry_date: date, source_type: source, memo: memo || undefined, evidence_ids: [],
              lines: lines.map((l) => ({
                account_id: l.account_id, location_id: l.location_id || locs[0]?.id,
                debit: l.debit ? D(l.debit).toFixed(4) : '0', credit: l.credit ? D(l.credit).toFixed(4) : '0',
              })),
            });
            router.push('/approvals');
          })}>Submit for approval</Button>
      </Card>
    </Page>
  );
}
