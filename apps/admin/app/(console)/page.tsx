'use client';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Card, Empty, ErrorNote, Page } from '@/components/ui';

export default function Overview() {
  const { me, entity } = useSession();
  const drafts = useApi<any[]>('/v1/drafts?state=pending');
  const reopens = useApi<any[]>('/v1/reopen-requests');
  const verify = useApi<any>(entity ? `/v1/entities/${entity.id}/verify` : null);
  const periods = useApi<any[]>(entity ? `/v1/periods?entity_id=${entity.id}` : null);
  const entries = useApi<any[]>(entity ? `/v1/entries?entity_id=${entity.id}&limit=8` : null);
  const pendingReopens = (reopens.data ?? []).filter((r) => r.state === 'pending');
  const firstOpen = (periods.data ?? []).find((p) => p.status === 'open');

  return (
    <Page title="Overview" lead={`Signed in as ${me?.principal_name} (${me?.role}).`}>
      <div className="stats">
        <Link href="/approvals" className="stat"><div className="stat-v">{drafts.data?.length ?? '…'}</div><div className="stat-l">Drafts awaiting approval</div></Link>
        <Link href="/approvals" className="stat"><div className="stat-v">{reopens.data ? pendingReopens.length : '…'}</div><div className="stat-l">Reopen requests</div></Link>
        <div className="stat">
          <div className="stat-v">{verify.data ? <Badge value={verify.data.ok} label={verify.data.ok ? 'Verified' : 'BROKEN'} /> : entity ? '…' : '—'}</div>
          <div className="stat-l">Hash chain{verify.data ? ` · ${verify.data.checked} entries` : ''}{verify.data?.reason ? ` · ${verify.data.reason} at #${verify.data.firstBadSeq}` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-v">{firstOpen ? `FY${firstOpen.fiscal_year} P${firstOpen.period_no}` : entity ? 'None' : '—'}</div>
          <div className="stat-l">Earliest open period{firstOpen ? ` · from ${String(firstOpen.start_date).slice(0, 10)}` : ''}</div>
        </div>
      </div>
      <ErrorNote error={verify.error ?? drafts.error} />
      {!entity ? (
        <Card title="Get started">
          <ol>
            <li><Link href="/accounts">Load the chart of accounts</Link> from the restaurant template.</li>
            <li><Link href="/entities">Add an entity</Link> (legal company), its locations, and a fiscal year.</li>
            <li><Link href="/members">Invite</Link> your controller and bookkeepers.</li>
          </ol>
        </Card>
      ) : (
        <Card title={`Latest entries — ${entity.legal_name}`} actions={<Link href="/journal">All entries →</Link>}>
          {entries.data?.length ? (
            <table>
              <thead><tr><th>#</th><th>Date</th><th>Source</th><th>Memo</th></tr></thead>
              <tbody>{entries.data.map((e) => (
                <tr key={e.id}><td><Link href={`/journal/${e.id}`}>{e.seq}</Link></td><td>{String(e.entry_date).slice(0, 10)}</td><td>{e.source_type}</td><td>{e.memo}</td></tr>
              ))}</tbody>
            </table>
          ) : <Empty>No entries yet.</Empty>}
        </Card>
      )}
    </Page>
  );
}
