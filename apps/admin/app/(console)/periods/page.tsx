'use client';
import { useEffect, useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Loading, Page, Select } from '@/components/ui';
import { calendarLabel } from '@/components/Shell';

export default function Periods() {
  const { entity, can } = useSession();
  const all = useApi<any[]>(entity ? `/v1/periods?entity_id=${entity.id}` : null);
  const years = [...new Set((all.data ?? []).map((p) => p.fiscal_year))].sort();
  const [fy, setFy] = useState<number | null>(null);
  useEffect(() => { if (years.length && (fy === null || !years.includes(fy))) setFy(years[years.length - 1]); }, [years.join(','), fy]);
  const rows = (all.data ?? []).filter((p) => p.fiscal_year === fy);
  const manage = can('owner', 'controller');
  const act = useAction();
  const [newYear, setNewYear] = useState('');

  return (
    <Page title="Periods" lead="Periods move forward only — open → soft → hard → sealed — and always in date order. Reopening needs a second person and never applies to sealed periods.">
      {!entity ? <Empty>Choose an entity.</Empty> : (
        <>
          <Card title={`${entity.legal_name} · ${calendarLabel(entity.fiscal_calendar)}`}
            actions={years.length ? (
              <Select value={fy ?? ''} onChange={(e) => setFy(Number(e.target.value))} aria-label="Fiscal year">
                {years.map((y) => <option key={y} value={y}>FY{y}</option>)}
              </Select>
            ) : null}>
            {all.loading ? <Loading /> : <ErrorNote error={all.error ?? act.error} />}
            {all.data && !rows.length ? <Empty>No fiscal years yet.</Empty> : null}
            {rows.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Period</th><th>Dates</th><th>Weeks</th><th>Status</th>{manage ? <th>Actions</th> : null}</tr></thead>
                  <tbody>{rows.map((p) => <PeriodRow key={p.id} p={p} manage={manage} run={act.run} reload={all.reload} />)}</tbody>
                </table>
              </div>
            ) : null}
          </Card>
          {manage ? (
            <Card title="Add a fiscal year">
              <p className="muted small">Years are contiguous: the next year, or the one before the earliest (to back-fill history).</p>
              <div className="row">
                <Field label="Fiscal year"><Input type="number" value={newYear} onChange={(e) => setNewYear(e.target.value)}
                  placeholder={years.length ? String(years[years.length - 1] + 1) : String(new Date().getFullYear())} /></Field>
                <Button variant="primary" disabled={act.busy || !newYear}
                  onClick={() => act.run(() => api('POST', '/v1/fiscal-years', { entity_id: entity.id, year: Number(newYear) })).then((ok) => { if (ok) { setFy(Number(newYear)); setNewYear(''); all.reload(); } })}>
                  Generate periods
                </Button>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </Page>
  );
}

function PeriodRow({ p, manage, run, reload }: { p: any; manage: boolean; run: (fn: () => Promise<unknown>) => Promise<boolean>; reload: () => void }) {
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const days = (Date.parse(p.end_date) - Date.parse(p.start_date)) / 86_400_000 + 1;
  const go = (fn: () => Promise<unknown>) => run(fn).then((ok) => ok && reload());
  return (
    <tr>
      <td>P{p.period_no}</td>
      <td>{String(p.start_date).slice(0, 10)} – {String(p.end_date).slice(0, 10)}</td>
      <td>{days % 7 === 0 ? days / 7 : '—'}</td>
      <td><Badge value={p.status} /></td>
      {manage ? (
        <td>
          <div className="row">
            {p.status === 'open' ? <Button onClick={() => go(() => api('POST', `/v1/periods/${p.id}/close`, { status: 'soft' }))}>Soft close</Button> : null}
            {p.status === 'open' || p.status === 'soft' ? <Button onClick={() => go(() => api('POST', `/v1/periods/${p.id}/close`, { status: 'hard' }))}>Hard close</Button> : null}
            {p.status === 'hard' ? <Button onClick={() => { if (confirm('Sealing is permanent. The chain hash is recorded and the period can never reopen.')) go(() => api('POST', `/v1/periods/${p.id}/seal`)); }}>Seal</Button> : null}
            {p.status === 'soft' || p.status === 'hard' ? (
              asking ? (
                <>
                  <Input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <Button disabled={!reason.trim()} onClick={() => go(() => api('POST', `/v1/periods/${p.id}/reopen-requests`, { target: 'open', reason })).then(() => setAsking(false))}>Request reopen</Button>
                </>
              ) : <Button variant="ghost" onClick={() => setAsking(true)}>Reopen…</Button>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}
