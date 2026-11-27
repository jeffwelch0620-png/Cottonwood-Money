'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { D, fmt, sum } from '@/lib/money';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Loading, Page, short } from '@/components/ui';

export default function EntryViewer() {
  const { id } = useParams<{ id: string }>();
  const q = useApi<any>(`/v1/entries/${id}`);
  const e = q.data;
  if (q.loading) return <Page title="Entry"><Loading /></Page>;
  if (!e) return <Page title="Entry"><ErrorNote error={q.error} /></Page>;
  const debits = sum(e.lines.map((l: any) => l.debit));
  const credits = sum(e.lines.map((l: any) => l.credit));

  return (
    <Page title={`Entry #${e.seq}`} lead={`${e.entity} · ${e.entry_date} · ${e.source_type}${e.memo ? ' · ' + e.memo : ''}`}
      actions={<Link href="/journal" className="btn">← Journal</Link>}>
      <div className="grid2">
        <Card title="Integrity">
          <dl className="kv">
            <dt>Content hash</dt><dd><span className={`check ${e.hash_ok ? 'ok' : 'bad'}`}>{e.hash_ok ? '✓ matches recomputed hash' : '✗ CONTENT CHANGED'}</span></dd>
            <dt>Chain link</dt><dd><span className={`check ${e.link_ok ? 'ok' : 'bad'}`}>{e.link_ok ? `✓ links to entry #${e.seq - 1 || 'genesis'}` : '✗ BROKEN LINK'}</span></dd>
            <dt>Hash</dt><dd className="hash">{e.hash}</dd>
            <dt>Previous hash</dt><dd className="hash">{e.prev_hash}</dd>
            <dt>Posted at</dt><dd>{new Date(e.posted_at).toLocaleString()}</dd>
            <dt>Period</dt><dd>FY{e.period?.fiscal_year} P{e.period?.period_no} <Badge value={e.period?.status} /></dd>
          </dl>
        </Card>
        <Card title="People">
          <dl className="kv">
            <dt>Created by</dt><dd>{e.created_by?.name} <span className="muted">({e.created_by?.kind})</span></dd>
            <dt>Approved by</dt><dd>{e.approved_by ? <>{e.approved_by.name} <span className="muted">({e.approved_by.kind})</span></> : <span className="muted">no approval required</span>}</dd>
            {e.draft_id ? <><dt>From draft</dt><dd className="mono">{short(e.draft_id)}</dd></> : null}
            {e.reverses ? <><dt>Reverses</dt><dd><Link href={`/journal/${e.reverses.id}`}>#{e.reverses.seq}</Link></dd></> : null}
            {e.reversed_by ? <><dt>Reversed by</dt><dd><Link href={`/journal/${e.reversed_by.id}`}>#{e.reversed_by.seq}</Link></dd></> : null}
            {e.ic_group_id ? <><dt>Intercompany</dt><dd className="mono">{short(e.ic_group_id)}</dd></> : null}
            <dt>Idempotency key</dt><dd className="mono">{e.idempotency_key}</dd>
          </dl>
        </Card>
      </div>
      <Card title="Lines">
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Account</th><th>Location</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>{e.lines.map((l: any) => (
              <tr key={l.line_no}><td>{l.line_no}</td><td>{l.account} {l.account_name}</td><td>{l.location}</td>
                <td className="num">{D(l.debit).isZero() ? '' : fmt(l.debit)}</td><td className="num">{D(l.credit).isZero() ? '' : fmt(l.credit)}</td></tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={3}>Total</td><td className="num">{fmt(debits)}</td><td className="num">{fmt(credits)}</td></tr></tfoot>
          </table>
        </div>
      </Card>
      <Card title="Evidence">
        {e.evidence.length ? (
          <table>
            <thead><tr><th>Type</th><th>Stored at</th><th>SHA-256</th><th>Received</th></tr></thead>
            <tbody>{e.evidence.map((d: any) => (
              <tr key={d.id}><td>{d.doc_type}</td><td className="mono">{d.storage_uri}</td><td className="hash">{d.sha256}</td><td className="small">{new Date(d.received_at).toLocaleString()}</td></tr>
            ))}</tbody>
          </table>
        ) : <Empty>No source documents (allowed only for manual and opening entries).</Empty>}
      </Card>
      {e.applications.length ? (
        <Card title="Payment applications">
          <table>
            <thead><tr><th>Payment</th><th>Document</th><th className="num">Amount</th><th>Settled on</th></tr></thead>
            <tbody>{e.applications.map((a: any) => (
              <tr key={a.id}><td><Link href={`/journal/${a.payment_entry_id}`}>{short(a.payment_entry_id)}</Link></td>
                <td><Link href={`/journal/${a.document_entry_id}`}>{short(a.document_entry_id)}</Link></td>
                <td className="num">{fmt(a.amount)}</td><td>{a.settled_on}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      ) : null}
      {!e.reversed_by && e.source_type !== 'reversal' && !e.ic_group_id ? <Reverse entry={e} onDone={q.reload} /> : null}
    </Page>
  );
}

function Reverse({ entry, onDone }: { entry: any; onDone: () => void }) {
  const { can } = useSession();
  const router = useRouter();
  const act = useAction();
  const [date, setDate] = useState('');
  if (!can('owner', 'controller', 'bookkeeper', 'manager')) return null;
  return (
    <Card title="Reverse this entry">
      <p className="muted small">You request the reversal; a different person approves it in Approvals. It mirrors every line and posts on the date you choose (an open period).</p>
      <div className="row">
        <Field label="Reversal date (blank = original)"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Button variant="danger" disabled={act.busy}
          onClick={() => act.run(async () => {
            await api('POST', `/v1/entries/${entry.id}/reverse`, date ? { entry_date: date } : {});
            onDone();
            router.push('/approvals');
          })}>Request reversal</Button>
      </div>
      <ErrorNote error={act.error} />
    </Card>
  );
}
