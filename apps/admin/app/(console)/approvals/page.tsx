'use client';
import { useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { D, fmt, sum } from '@/lib/money';
import { Badge, Button, Card, Empty, ErrorNote, Input, Loading, Page } from '@/components/ui';

interface Draft {
  id: string; entity_id: string; payload: any; created_by: string; created_by_name: string; created_by_kind: string;
  created_at: string; state: string; reason: string | null; entry_id: string | null;
}

export default function Approvals() {
  const { me, entities } = useSession();
  const drafts = useApi<Draft[]>('/v1/drafts?state=pending');
  const reopens = useApi<any[]>('/v1/reopen-requests');
  const accounts = useApi<any[]>('/v1/accounts');
  const acct = (id: string) => accounts.data?.find((a) => a.id === id);
  const entityName = (id: string) => entities.find((e) => e.id === id)?.legal_name ?? id.slice(0, 8);
  const pendingReopens = (reopens.data ?? []).filter((r) => r.state === 'pending');

  return (
    <Page title="Approvals" lead="A different person must approve each draft and each reopen. The ledger re-checks every rule at approval — period, balance, your approval limit and location scope.">
      <Card title={`Journal entry drafts (${drafts.data?.length ?? 0})`}>
        {drafts.loading ? <Loading /> : <ErrorNote error={drafts.error} />}
        {drafts.data && !drafts.data.length ? <Empty>Nothing waiting.</Empty> : null}
        {drafts.data?.map((d) => (
          <DraftRow key={d.id} d={d} mine={d.created_by === me?.principal_id} acct={acct} entityName={entityName} onDone={drafts.reload} />
        ))}
      </Card>
      <Card title={`Period reopen requests (${pendingReopens.length})`}>
        {!pendingReopens.length ? <Empty>Nothing waiting.</Empty> : (
          <table>
            <thead><tr><th>Entity</th><th>Change</th><th>Reason</th><th>Requested</th><th /></tr></thead>
            <tbody>{pendingReopens.map((r) => <ReopenRow key={r.id} r={r} entityName={entityName} mine={r.requested_by === me?.principal_id} onDone={reopens.reload} />)}</tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

function DraftRow({ d, mine, acct, entityName, onDone }: { d: Draft; mine: boolean; acct: (id: string) => any; entityName: (id: string) => string; onDone: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState('');
  const [soft, setSoft] = useState(false);
  const lines: any[] = d.payload.lines ?? [];
  const total = sum(lines.map((l) => l.debit ?? 0));
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-head">
        <div>
          <strong>{d.payload.memo || d.payload.source_type}</strong>{' '}
          <span className="muted">· {entityName(d.entity_id)} · {d.payload.entry_date} · {d.payload.source_type}</span>
          <div className="muted small">Proposed by {d.created_by_name} ({d.created_by_kind}) · {new Date(d.created_at).toLocaleString()}</div>
        </div>
        <div className="num"><strong>{fmt(total)}</strong></div>
      </div>
      <table>
        <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>{lines.map((l, i) => {
          const a = acct(l.account_id);
          return <tr key={i}><td>{a ? `${a.number} ${a.name}` : l.account_id}</td><td className="num">{D(l.debit).isZero() ? '' : fmt(l.debit)}</td><td className="num">{D(l.credit).isZero() ? '' : fmt(l.credit)}</td></tr>;
        })}</tbody>
      </table>
      <ErrorNote error={act.error} />
      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" disabled={act.busy || mine} title={mine ? 'You proposed this draft; someone else must approve it' : ''}
          onClick={() => act.run(() => api('POST', `/v1/drafts/${d.id}/approve`, { allow_soft_close: soft })).then((ok) => ok && onDone())}>
          Approve and post
        </Button>
        <label className="small"><input type="checkbox" checked={soft} onChange={(e) => setSoft(e.target.checked)} /> Post into a soft-closed period (owner/controller)</label>
        <Input placeholder={mine ? 'Reason for withdrawing' : 'Reason for rejecting'} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: '1 1 200px' }} />
        <Button variant="danger" disabled={act.busy || !reason.trim()}
          onClick={() => act.run(() => api('POST', `/v1/drafts/${d.id}/reject`, { reason })).then((ok) => ok && onDone())}>
          {mine ? 'Withdraw' : 'Reject'}
        </Button>
        {mine ? <Badge value="pending" label="Yours — needs another approver" /> : null}
      </div>
    </div>
  );
}

function ReopenRow({ r, entityName, mine, onDone }: { r: any; entityName: (id: string) => string; mine: boolean; onDone: () => void }) {
  const act = useAction();
  return (
    <>
      <tr>
        <td>{entityName(r.entity_id)}</td>
        <td><Badge value={r.from_status} /> → <Badge value={r.target_status} /></td>
        <td>{r.reason}</td>
        <td className="small muted">{new Date(r.requested_at).toLocaleString()}</td>
        <td className="num">
          <Button variant="primary" disabled={act.busy || mine} title={mine ? 'You requested this; someone else must approve' : ''}
            onClick={() => act.run(() => api('POST', `/v1/reopen-requests/${r.id}/approve`)).then((ok) => ok && onDone())}>Approve</Button>{' '}
          <Button variant="danger" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/reopen-requests/${r.id}/reject`)).then((ok) => ok && onDone())}>Reject</Button>
        </td>
      </tr>
      {act.error ? <tr><td colSpan={5}><ErrorNote error={act.error} /></td></tr> : null}
    </>
  );
}
