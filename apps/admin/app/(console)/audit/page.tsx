'use client';
import { useState } from 'react';
import { apiRaw, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Page } from '@/components/ui';

interface ExportResult { format: string; chainOk: boolean; checked: string; firstBad: string | null; sha256: string; events: number; preview: any[] }

export default function Audit() {
  const { entities, can } = useSession();
  const act = useAction();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [res, setRes] = useState<ExportResult | null>(null);
  const allowed = can('owner', 'controller');

  const run = (format: 'jsonl' | 'csv') => act.run(async () => {
    const qs = new URLSearchParams({ format, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to + 'T23:59:59.999').toISOString() } : {}) });
    const { body, headers } = await apiRaw(`/v1/audit/export?${qs}`);
    const lines = format === 'jsonl' ? body.trim().split('\n').filter(Boolean) : body.trim().split('\n').slice(1);
    setRes({
      format, chainOk: headers.get('x-audit-chain-ok') === 'true', checked: headers.get('x-audit-chain-checked') ?? '?',
      firstBad: headers.get('x-audit-chain-first-bad-seq'), sha256: headers.get('x-export-sha256') ?? '', events: lines.length,
      preview: format === 'jsonl' ? lines.slice(-15).reverse().map((l) => JSON.parse(l)) : [],
    });
    const url = URL.createObjectURL(new Blob([body], { type: format === 'jsonl' ? 'application/x-ndjson' : 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `audit-${new Date().toISOString().slice(0, 10)}.${format}` });
    a.click();
    URL.revokeObjectURL(url);
  });

  return (
    <Page title="Audit" lead="Every posting, approval, close, membership and setup change is an append-only, hash-chained event. Exports carry the chain check and a SHA-256 of the exact file.">
      {!allowed ? <Card><Empty>Only an owner or controller can export the audit log.</Empty></Card> : (
        <Card title="Export">
          <div className="row">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Button variant="primary" disabled={act.busy} onClick={() => run('jsonl')}>Download JSONL</Button>
            <Button disabled={act.busy} onClick={() => run('csv')}>Download CSV</Button>
          </div>
          <ErrorNote error={act.error} />
          {res ? (
            <>
              <dl className="kv" style={{ marginTop: 12 }}>
                <dt>Audit chain</dt><dd>{res.chainOk ? <span className="check ok">✓ intact ({res.checked} events checked)</span> : <span className="check bad">✗ BROKEN at event #{res.firstBad}</span>}</dd>
                <dt>Events exported</dt><dd>{res.events}</dd>
                <dt>File SHA-256</dt><dd className="hash">{res.sha256}</dd>
              </dl>
              {res.preview.length ? (
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table>
                    <thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Object</th></tr></thead>
                    <tbody>{res.preview.map((e) => (
                      <tr key={e.seq}><td>{e.seq}</td><td className="small">{new Date(e.at).toLocaleString()}</td><td>{e.actor_name ?? e.actor_type}</td><td className="mono">{e.action}</td><td className="small muted">{e.object_type}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </Card>
      )}
      <Card title="Ledger hash chains">
        {entities.length ? <table><tbody>{entities.map((e) => <ChainRow key={e.id} id={e.id} name={e.legal_name} />)}</tbody></table> : <Empty>No entities.</Empty>}
      </Card>
    </Page>
  );
}

function ChainRow({ id, name }: { id: string; name: string }) {
  const v = useApi<any>(`/v1/entities/${id}/verify`);
  return (
    <tr>
      <td>{name}</td>
      <td>{v.data ? <Badge value={v.data.ok} label={v.data.ok ? 'Verified' : `${v.data.reason} at #${v.data.firstBadSeq}`} /> : v.error ? <ErrorNote error={v.error} /> : '…'}</td>
      <td className="muted small">{v.data ? `${v.data.checked} entries` : ''}</td>
      <td className="num"><Button variant="ghost" onClick={v.reload}>Re-verify</Button></td>
    </tr>
  );
}
