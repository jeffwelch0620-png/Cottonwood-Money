'use client';
import { useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Loading, Page, Select } from '@/components/ui';

const CASH_VIEW: Record<string, string> = { always: 'Always (entry date)', never: 'Never (AR/AP and accruals)', settle: 'When settled (P&L)' };

export default function Accounts() {
  const { can } = useSession();
  const list = useApi<any[]>('/v1/accounts');
  const edit = can('owner', 'controller');
  const act = useAction();
  const [filter, setFilter] = useState('');
  const rows = (list.data ?? []).filter((a) => !filter || `${a.number} ${a.name} ${a.type}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Page title="Chart of accounts"
      lead="Number, type, normal balance and the intercompany flag never change; the cash-basis setting is fixed once an account has postings. Rename or deactivate instead."
      actions={edit ? (
        <Button onClick={() => act.run(() => api('POST', '/v1/coa/template', { template: 'usar' })).then((ok) => ok && list.reload())} disabled={act.busy}>
          Load restaurant template (USAR-style)
        </Button>
      ) : null}>
      <ErrorNote error={act.error} />
      {edit ? <NewAccount onDone={list.reload} /> : null}
      <Card title={`Accounts (${list.data?.length ?? 0})`} actions={<Input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
        {list.loading ? <Loading /> : <ErrorNote error={list.error} />}
        {list.data && !list.data.length ? <Empty>No accounts yet. Load the template to start.</Empty> : null}
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Number</th><th>Name</th><th>Type</th><th>Normal</th><th>Cash basis</th><th>USAR group</th><th>Status</th></tr></thead>
              <tbody>{rows.map((a) => <AccountRow key={a.id} a={a} edit={edit} onDone={list.reload} />)}</tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </Page>
  );
}

function AccountRow({ a, edit, onDone }: { a: any; edit: boolean; onDone: () => void }) {
  const act = useAction();
  const [name, setName] = useState<string | null>(null);
  const save = (body: object) => act.run(() => api('PATCH', `/v1/accounts/${a.id}`, body)).then((ok) => { if (ok) { setName(null); onDone(); } });
  return (
    <>
      <tr>
        <td className="mono">{a.number}</td>
        <td>
          {name !== null ? (
            <span className="row">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              <Button variant="primary" onClick={() => save({ name })} disabled={!name.trim()}>Save</Button>
              <Button variant="ghost" onClick={() => setName(null)}>Cancel</Button>
            </span>
          ) : (
            <>{a.name}{a.is_intercompany ? <span className="muted small"> · intercompany</span> : null}
              {edit ? <Button variant="ghost" className="small" onClick={() => setName(a.name)}>Rename</Button> : null}</>
          )}
        </td>
        <td>{a.type}</td>
        <td>{a.normal_balance === 'D' ? 'Debit' : 'Credit'}</td>
        <td className="small">{CASH_VIEW[a.cash_view]}</td>
        <td className="small muted">{a.usar_code ?? ''}</td>
        <td>
          <Badge value={a.active ? 'active' : 'inactive'} />
          {edit ? <Button variant="ghost" className="small" onClick={() => save({ active: !a.active })}>{a.active ? 'Deactivate' : 'Activate'}</Button> : null}
        </td>
      </tr>
      {act.error ? <tr><td colSpan={7}><ErrorNote error={act.error} /></td></tr> : null}
    </>
  );
}

function NewAccount({ onDone }: { onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ number: '', name: '', type: 'expense', normal_balance: 'D', cash_view: 'settle' });
  const set = (k: string, v: string) => setF((x) => ({
    ...x, [k]: v,
    ...(k === 'type' ? { normal_balance: ['asset', 'expense'].includes(v) ? 'D' : 'C', cash_view: ['revenue', 'expense'].includes(v) ? 'settle' : 'always' } : {}),
  }));
  return (
    <Card title="Add an account">
      <div className="row">
        <Field label="Number"><Input value={f.number} onChange={(e) => set('number', e.target.value)} /></Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Type"><Select value={f.type} onChange={(e) => set('type', e.target.value)}>
          {['asset', 'liability', 'equity', 'revenue', 'expense'].map((t) => <option key={t}>{t}</option>)}
        </Select></Field>
        <Field label="Normal balance"><Select value={f.normal_balance} onChange={(e) => set('normal_balance', e.target.value)}><option value="D">Debit</option><option value="C">Credit</option></Select></Field>
        <Field label="Cash basis"><Select value={f.cash_view} onChange={(e) => set('cash_view', e.target.value)}>
          {Object.entries(CASH_VIEW).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select></Field>
        <Button variant="primary" disabled={act.busy || !f.number || !f.name}
          onClick={() => act.run(() => api('POST', '/v1/accounts', f)).then((ok) => { if (ok) { setF({ ...f, number: '', name: '' }); onDone(); } })}>Add</Button>
      </div>
      <ErrorNote error={act.error} />
    </Card>
  );
}
