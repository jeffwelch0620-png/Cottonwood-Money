'use client';
import { useState } from 'react';
import { api, useAction, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Card, Empty, ErrorNote, Field, Input, Page, Select } from '@/components/ui';
import { calendarLabel } from '@/components/Shell';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function Entities() {
  const { entities, reloadEntities, setEntityId, can } = useSession();
  const locations = useApi<any[]>('/v1/locations');
  const edit = can('owner', 'controller');
  return (
    <Page title="Entities and locations" lead="An entity is a legal company with its own books and fiscal calendar; locations are its stores. Calendar settings are fixed once the entity has periods.">
      {edit ? <NewEntity onDone={(id) => { reloadEntities(); setEntityId(id); }} /> : null}
      {!entities.length ? <Empty>No entities yet.</Empty> : entities.map((e) => (
        <Card key={e.id} title={e.legal_name}>
          <p className="muted small">
            {calendarLabel(e.fiscal_calendar)} · year ends {e.fiscal_calendar === 'calendar_month' ? `end of ${MONTHS[e.fy_end_month - 1]}` : `on the ${DAYS[e.week_end_dow]} ${e.fy_week_rule === 'nearest' ? 'nearest' : 'on or before'} the end of ${MONTHS[e.fy_end_month - 1]}`} · default basis {e.default_basis}
          </p>
          <table>
            <thead><tr><th>Location</th><th>Time zone</th><th>POS</th></tr></thead>
            <tbody>{(locations.data ?? []).filter((l) => l.entity_id === e.id).map((l) => (
              <tr key={l.id}><td>{l.name}</td><td>{l.timezone}</td><td>{l.pos_system ?? ''} {l.pos_location_ref ?? ''}</td></tr>
            ))}</tbody>
          </table>
          {edit ? <NewLocation entityId={e.id} onDone={locations.reload} /> : null}
        </Card>
      ))}
    </Page>
  );
}

function NewEntity({ onDone }: { onDone: (id: string) => void }) {
  const act = useAction();
  const [f, setF] = useState({ legal_name: '', ein: '', default_basis: 'accrual', fiscal_calendar: 'calendar_month', fy_end_month: 12, week_end_dow: 0, fy_week_rule: 'nearest' });
  const weeks = f.fiscal_calendar !== 'calendar_month';
  return (
    <Card title="Add an entity">
      <div className="row">
        <Field label="Legal name"><Input value={f.legal_name} onChange={(e) => setF({ ...f, legal_name: e.target.value })} /></Field>
        <Field label="EIN"><Input value={f.ein} onChange={(e) => setF({ ...f, ein: e.target.value })} /></Field>
        <Field label="Default basis"><Select value={f.default_basis} onChange={(e) => setF({ ...f, default_basis: e.target.value })}><option value="accrual">Accrual</option><option value="cash">Cash</option></Select></Field>
      </div>
      <div className="row">
        <Field label="Fiscal calendar"><Select value={f.fiscal_calendar} onChange={(e) => setF({ ...f, fiscal_calendar: e.target.value })}>
          <option value="calendar_month">Calendar months</option><option value="445">4-4-5 weeks</option><option value="13_period">13 periods of 4 weeks</option>
        </Select></Field>
        <Field label="Year-end month"><Select value={f.fy_end_month} onChange={(e) => setF({ ...f, fy_end_month: Number(e.target.value) })}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </Select></Field>
        {weeks ? (
          <>
            <Field label="Weeks end on"><Select value={f.week_end_dow} onChange={(e) => setF({ ...f, week_end_dow: Number(e.target.value) })}>
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select></Field>
            <Field label="Year ends" hint="Nearest gives 52/53-week years"><Select value={f.fy_week_rule} onChange={(e) => setF({ ...f, fy_week_rule: e.target.value })}>
              <option value="nearest">Nearest that day to month end</option><option value="last">Last one on or before month end</option>
            </Select></Field>
          </>
        ) : null}
      </div>
      <ErrorNote error={act.error} />
      <Button variant="primary" disabled={act.busy || !f.legal_name}
        onClick={() => act.run(async () => {
          const r = await api('POST', '/v1/entities', { ...f, ein: f.ein || undefined });
          setF({ ...f, legal_name: '', ein: '' });
          onDone(r.id);
        })}>Add entity</Button>
    </Card>
  );
}

function NewLocation({ entityId, onDone }: { entityId: string; onDone: () => void }) {
  const act = useAction();
  const [name, setName] = useState('');
  const [tz, setTz] = useState('America/New_York');
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <Field label="New location"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Store name" /></Field>
      <Field label="Time zone"><Input value={tz} onChange={(e) => setTz(e.target.value)} /></Field>
      <Button disabled={act.busy || !name} onClick={() => act.run(() => api('POST', '/v1/locations', { entity_id: entityId, name, timezone: tz })).then((ok) => { if (ok) { setName(''); onDone(); } })}>Add location</Button>
      <ErrorNote error={act.error} />
    </div>
  );
}
