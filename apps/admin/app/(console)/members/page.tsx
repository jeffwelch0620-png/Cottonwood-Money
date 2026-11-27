'use client';
import { useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { fmt } from '@/lib/money';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Loading, Page, Select, short } from '@/components/ui';

const ROLES = ['owner', 'controller', 'bookkeeper', 'manager', 'viewer', 'service'];
const ROLE_NOTE: Record<string, string> = {
  owner: 'Members, principals, and everything a controller does',
  controller: 'Chart of accounts, periods, soft-close posting, sealing',
  bookkeeper: 'Posts and approves within location scope and approval limit',
  manager: 'Same as bookkeeper, usually location-scoped',
  viewer: 'Read only',
  service: 'Machine login for an agent or integration; never approves',
};

export default function Members() {
  const { me, can } = useSession();
  const list = useApi<any[]>('/v1/members');
  const locations = useApi<any[]>('/v1/locations');
  const owner = can('owner');
  const locName = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? short(id);
  return (
    <Page title="Members" lead="Every role or limit change is an audit event. People need MFA; a tenant always keeps at least one active owner.">
      {owner ? <AddMember onDone={list.reload} locations={locations.data ?? []} /> : null}
      <Card title={`Members (${list.data?.length ?? 0})`}>
        {list.loading ? <Loading /> : <ErrorNote error={list.error} />}
        {list.data && !list.data.length ? <Empty>No members.</Empty> : null}
        {list.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Role</th><th>Locations</th><th className="num">Approval limit</th><th>Status</th></tr></thead>
              <tbody>{list.data.map((m) => (
                <MemberRow key={m.id} m={m} owner={owner} self={m.principal_id === me?.principal_id} locName={locName} onDone={list.reload} />
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </Page>
  );
}

function MemberRow({ m, owner, self, locName, onDone }: { m: any; owner: boolean; self: boolean; locName: (id: string) => string; onDone: () => void }) {
  const act = useAction();
  const [limit, setLimit] = useState<string | null>(null);
  const save = (body: object) => act.run(() => api('PATCH', `/v1/members/${m.id}`, body)).then((ok) => { if (ok) { setLimit(null); onDone(); } });
  return (
    <>
      <tr>
        <td>{m.name ?? <span className="muted">no principal</span>}{self ? <span className="muted small"> (you)</span> : null}<div className="muted small">{m.kind}</div></td>
        <td>{owner ? (
          <Select value={m.role} onChange={(e) => save({ role: e.target.value })} title={ROLE_NOTE[m.role]}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </Select>
        ) : m.role}</td>
        <td className="small">{m.location_ids ? m.location_ids.map(locName).join(', ') : 'All'}</td>
        <td className="num">{limit !== null ? (
          <span className="row">
            <Input className="num" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Blank = unlimited" />
            <Button variant="primary" onClick={() => save({ approval_limit: limit.trim() || null })}>Save</Button>
          </span>
        ) : (
          <>{m.approval_limit ? fmt(m.approval_limit) : 'Unlimited'}{owner ? <Button variant="ghost" className="small" onClick={() => setLimit(m.approval_limit ?? '')}>Edit</Button> : null}</>
        )}</td>
        <td>
          <Badge value={m.active ? 'active' : 'inactive'} />
          {owner ? <Button variant="ghost" className="small" onClick={() => save({ active: !m.active })}>{m.active ? 'Deactivate' : 'Reactivate'}</Button> : null}
        </td>
      </tr>
      {act.error ? <tr><td colSpan={5}><ErrorNote error={act.error} /></td></tr> : null}
    </>
  );
}

function AddMember({ onDone, locations }: { onDone: () => void; locations: any[] }) {
  const act = useAction();
  const [f, setF] = useState({ user_id: '', name: '', role: 'bookkeeper', kind: 'integration', approval_limit: '', location_ids: [] as string[] });
  return (
    <Card title="Add a member">
      <p className="muted small">The person signs up in Supabase Auth first; paste their user id here. (An invite-by-email flow comes with the Supabase deployment.)</p>
      <div className="row">
        <Field label="Supabase user id"><Input value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} /></Field>
        <Field label="Display name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Role" hint={ROLE_NOTE[f.role]}><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        {f.role === 'service' ? (
          <Field label="Machine kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="integration">Integration</option><option value="agent">AI agent</option></Select></Field>
        ) : null}
        <Field label="Approval limit" hint="Blank = unlimited"><Input value={f.approval_limit} onChange={(e) => setF({ ...f, approval_limit: e.target.value })} /></Field>
      </div>
      {locations.length ? (
        <Field label="Location scope" hint="None ticked = all locations">
          <div className="row">{locations.map((l) => (
            <label key={l.id} className="small"><input type="checkbox" checked={f.location_ids.includes(l.id)}
              onChange={(e) => setF({ ...f, location_ids: e.target.checked ? [...f.location_ids, l.id] : f.location_ids.filter((x) => x !== l.id) })} /> {l.name}</label>
          ))}</div>
        </Field>
      ) : null}
      <ErrorNote error={act.error} />
      <Button variant="primary" disabled={act.busy || !f.user_id || !f.name}
        onClick={() => act.run(() => api('POST', '/v1/members', {
          user_id: f.user_id.trim(), name: f.name, role: f.role, ...(f.role === 'service' ? { kind: f.kind } : {}),
          ...(f.approval_limit ? { approval_limit: f.approval_limit } : {}), ...(f.location_ids.length ? { location_ids: f.location_ids } : {}),
        })).then((ok) => { if (ok) { setF({ ...f, user_id: '', name: '' }); onDone(); } })}>Add member</Button>
    </Card>
  );
}
