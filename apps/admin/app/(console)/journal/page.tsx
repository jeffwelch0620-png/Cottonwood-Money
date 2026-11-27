'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { fmt } from '@/lib/money';
import { Button, Empty, ErrorNote, Field, Input, Loading, Page, Card } from '@/components/ui';

export default function Journal() {
  const { entity } = useSession();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [before, setBefore] = useState<number | null>(null);
  const qs = new URLSearchParams({ limit: '50', ...(entity ? { entity_id: entity.id } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(before ? { before_seq: String(before) } : {}) });
  const list = useApi<any[]>(entity ? `/v1/entries?${qs}` : null);

  return (
    <Page title="Journal" lead={entity ? `Posted entries for ${entity.legal_name}, newest first. Posted entries never change; corrections are reversals.` : 'Choose an entity.'}
      actions={<Link href="/journal/new" className="btn btn-primary">New entry</Link>}>
      <Card>
        <div className="row">
          <Field label="From"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setBefore(null); }} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setBefore(null); }} /></Field>
        </div>
        {list.loading ? <Loading /> : <ErrorNote error={list.error} />}
        {list.data && !list.data.length ? <Empty>No entries.</Empty> : null}
        {list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Date</th><th>Source</th><th>Memo</th><th className="num">Amount</th><th>Hash</th></tr></thead>
              <tbody>{list.data.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/journal/${e.id}`}>{e.seq}</Link></td>
                  <td>{String(e.entry_date).slice(0, 10)}</td>
                  <td>{e.source_type}{e.reverses_id ? ' ↩' : ''}</td>
                  <td>{e.memo}</td>
                  <td className="num">{fmt(e.total)}</td>
                  <td className="hash">{String(e.hash).slice(0, 12)}…</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
        <div className="row" style={{ marginTop: 10 }}>
          {before ? <Button onClick={() => setBefore(null)}>Newest</Button> : null}
          {list.data?.length === 50 ? <Button onClick={() => setBefore(list.data![list.data!.length - 1].seq)}>Older →</Button> : null}
        </div>
      </Card>
    </Page>
  );
}
