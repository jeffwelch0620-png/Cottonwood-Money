// Phase 0 step 6: fiscal calendars, soft/hard close, sealing order, two-person reopen.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { appClient, appPool, superClient, makeFixture, dsj, post, actAs, expectCode, type Fixture } from './helpers.js';

let db: pg.Client;
let su: pg.Client;
let f: Fixture;

beforeAll(async () => {
  db = await appClient();
  su = await superClient();
  f = await makeFixture(db);
});
afterAll(async () => {
  await db.end();
  await su.end();
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** A new entity (with one location) in fixture f, created by its controller. */
async function newEntity(cal: string, over: { fy_end_month?: number; week_end_dow?: number; fy_week_rule?: string } = {}) {
  await actAs(db, f.user1);
  const { rows } = await db.query(
    `insert into entity (tenant_id, legal_name, fiscal_calendar, fy_end_month, week_end_dow, fy_week_rule)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [f.tenant, `${cal} ${randomUUID().slice(0, 6)}`, cal, over.fy_end_month ?? 12, over.week_end_dow ?? 0, over.fy_week_rule ?? 'nearest']);
  const loc = (await db.query(`insert into location (tenant_id, entity_id, name) values ($1, $2, 'Store') returning id`,
    [f.tenant, rows[0].id])).rows[0].id as string;
  return { id: rows[0].id as string, loc };
}

async function periodsOf(entity: string, fy?: number) {
  const { rows } = await db.query(
    `select id, fiscal_year, period_no, start_date, end_date, status, (end_date - start_date + 1) days
       from period where entity_id = $1 and ($2::int is null or fiscal_year = $2) order by start_date`, [entity, fy ?? null]);
  return rows.map((r) => ({ ...r, start: ymd(r.start_date), end: ymd(r.end_date), weeks: r.days / 7 }));
}

describe('fiscal calendars', () => {
  it('calendar months: FY2026 with a December year end is Jan 1 - Dec 31 in 12 months', async () => {
    const p = await periodsOf(f.entityA, 2026);
    expect(p.map((x) => x.period_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect([p[0].start, p[11].end]).toEqual(['2026-01-01', '2026-12-31']);
    expect(p[1].end).toBe('2026-02-28');
  });

  it('calendar months: a June year end makes FY2026 = Jul 1 2025 - Jun 30 2026', async () => {
    const e = await newEntity('calendar_month', { fy_end_month: 6 });
    await db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]);
    const p = await periodsOf(e.id);
    expect([p[0].start, p[11].end, p.length]).toEqual(['2025-07-01', '2026-06-30', 12]);
  });

  it('4-4-5, Sunday nearest Dec 31: FY2026 is a 53-week year, the extra week in period 12', async () => {
    // Dec 31 2026 is a Thursday -> nearest Sunday is Jan 3 2027. Dec 31 2025 (Wed) -> Sunday Dec 28 2025.
    const e = await newEntity('445');
    await db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]);
    await db.query('select ledger.create_fiscal_year($1, 2027)', [e.id]);
    const y26 = await periodsOf(e.id, 2026);
    expect([y26[0].start, y26[11].end]).toEqual(['2025-12-29', '2027-01-03']);
    expect(y26.map((x) => x.weeks)).toEqual([4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 6]);
    const y27 = await periodsOf(e.id, 2027);
    expect([y27[0].start, y27[11].end]).toEqual(['2027-01-04', '2028-01-02']);
    expect(y27.map((x) => x.weeks)).toEqual([4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5]);
    expect(new Date(y27[11].end).getUTCDay()).toBe(0); // ends on a Sunday
  });

  it('13 periods: 13 x 4 weeks; a 53-week year makes period 13 five weeks', async () => {
    const e = await newEntity('13_period');
    await db.query('select ledger.create_fiscal_year($1, 2027)', [e.id]);
    await db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]); // back-fill the prior year
    const p = await periodsOf(e.id);
    expect(p.filter((x) => x.fiscal_year === 2027).map((x) => x.weeks)).toEqual(Array(13).fill(4));
    expect(p.filter((x) => x.fiscal_year === 2026).map((x) => x.weeks)).toEqual([...Array(12).fill(4), 5]);
  });

  it("'last' rule: the year ends on the last Sunday on or before Dec 31", async () => {
    const e = await newEntity('445', { fy_week_rule: 'last' });
    await db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]);
    const p = await periodsOf(e.id);
    expect([p[0].start, p[11].end]).toEqual(['2025-12-29', '2026-12-27']);
  });

  it('every week-based setting, 2000-2060: years are 52/53 weeks, contiguous, end on the week-end day', async () => {
    const { rows } = await su.query(`
      with s as (
        select cal, m, dow, rule from unnest(array['445','13_period']) cal, generate_series(1, 12) m,
               generate_series(0, 6) dow, unnest(array['nearest','last']) rule),
      y as (
        select s.*, yr,
               ledger.fy_end(row(null,null,null,null,'USD','accrual',cal,m,dow,rule)::public.entity, yr - 1) + 1 as st,
               ledger.fy_end(row(null,null,null,null,'USD','accrual',cal,m,dow,rule)::public.entity, yr) as en
          from s, generate_series(2000, 2060) yr)
      select count(*) filter (where en - st + 1 not in (364, 371))::int bad_len,
             count(*) filter (where extract(dow from en) <> dow)::int bad_dow,
             count(*) filter (where en - st + 1 = 371)::int long_years,
             count(*)::int n
        from y`);
    expect(rows[0]).toMatchObject({ bad_len: 0, bad_dow: 0 });
    // 53-week years come up about every 5-6 years: 61 years x 336 settings -> ~10-12 per setting.
    const perSetting = rows[0].long_years / 336;
    expect(perSetting).toBeGreaterThan(9);
    expect(perSetting).toBeLessThan(13);
  });

  it('ten consecutive 4-4-5 years tile the calendar with no gaps or overlaps', async () => {
    const e = await newEntity('445', { fy_end_month: 9, week_end_dow: 1 });
    for (let y = 2025; y < 2035; y++) await db.query('select ledger.create_fiscal_year($1, $2)', [e.id, y]);
    const p = await periodsOf(e.id);
    expect(p.length).toBe(120);
    for (let i = 1; i < p.length; i++) {
      expect(new Date(p[i].start).getTime() - new Date(p[i - 1].end).getTime()).toBe(86_400_000);
    }
  });

  it('a posting date lands in the right 4-4-5 period', async () => {
    const e = await newEntity('445');
    await db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]);
    // FY2026 starts Dec 29 2025; period 2 = weeks 5-8 = Jan 26 - Feb 22 2026.
    const r = await post(db, dsj(f, { entity_id: e.id, entry_date: '2026-01-26', lines: [
      { account_id: f.acct.clearing, location_id: e.loc, debit: '10' },
      { account_id: f.acct.sales, location_id: e.loc, credit: '10' },
    ] }));
    const { rows } = await db.query(
      'select p.period_no from ledger.journal_entry j join period p on p.id = j.period_id where j.id = $1', [r.id]);
    expect(rows[0].period_no).toBe(2);
  });

  it('refuses duplicate years, gaps, direct inserts, and calendar changes once periods exist', async () => {
    const e = await newEntity('calendar_month');
    await db.query(`update entity set fiscal_calendar = '445' where id = $1`, [e.id]); // allowed: no periods yet
    await db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]);
    await expectCode(db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]), 'FISCAL_YEAR_EXISTS');
    await expectCode(db.query('select ledger.create_fiscal_year($1, 2028)', [e.id]), 'FISCAL_YEAR_GAP');
    await expectCode(db.query(`update entity set fiscal_calendar = '13_period' where id = $1`, [e.id]), 'CALENDAR_FIXED');
    await expectCode(db.query(`update entity set week_end_dow = 6 where id = $1`, [e.id]), 'CALENDAR_FIXED');
    await expect(db.query(`insert into period (tenant_id, entity_id, start_date, end_date, fiscal_year, period_no)
      values ($1, $2, '2030-01-01', '2030-01-31', 2030, 1)`, [f.tenant, e.id])).rejects.toThrow(/permission denied/);
    const s = await superClient();
    await expect(s.query(`insert into period (tenant_id, entity_id, start_date, end_date)
      values ($1, $2, '2031-01-01', '2031-01-31')`, [f.tenant, e.id])).rejects.toThrow(/period_has_fiscal_position/);
    await s.end();
  });

  it('only a person with owner/controller role creates fiscal years, in their own tenant', async () => {
    const e = await newEntity('calendar_month');
    await actAs(db, f.clerk);
    await expectCode(db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]), 'ROLE_FORBIDDEN');
    await actAs(db, f.integration);
    await expectCode(db.query('select ledger.create_fiscal_year($1, 2026)', [e.id]), 'APPROVER_NOT_USER');
    const other = await makeFixture(db); // acting as other's owner now
    await expectCode(db.query('select ledger.create_fiscal_year($1, 2027)', [f.entityA]), 'UNKNOWN_ENTITY');
    void other;
  });
});

describe('close: forward only, in date order', () => {
  it('soft and hard close move forward with an audit event; backward is refused', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    await db.query(`select ledger.close_period($1, 'soft')`, [fx.periods.novA]); // Oct is soft: ok
    await expectCode(db.query(`select ledger.close_period($1, 'hard')`, [fx.periods.novA]), 'CLOSE_ORDER'); // Oct only soft
    await db.query(`select ledger.close_period($1, 'hard')`, [fx.periods.octA]);
    await db.query(`select ledger.close_period($1, 'hard')`, [fx.periods.novA]);
    await expectCode(db.query(`select ledger.close_period($1, 'soft')`, [fx.periods.novA]), 'PERIOD_BACKWARD');
    await expectCode(db.query(`select ledger.close_period($1, 'sealed')`, [fx.periods.novA]), 'BAD_INPUT');
    const { rows } = await db.query(
      `select detail from audit.event where action = 'period.close' and object_id = $1 order by seq`, [fx.periods.novA]);
    expect(rows.map((r) => [r.detail.from, r.detail.to])).toEqual([['open', 'soft'], ['soft', 'hard']]);
  });

  it('a bookkeeper or agent cannot close', async () => {
    await actAs(db, f.clerk);
    await expectCode(db.query(`select ledger.close_period($1, 'soft')`, [f.periods.novA]), 'ROLE_FORBIDDEN');
    await actAs(db, f.agent);
    await expectCode(db.query(`select ledger.close_period($1, 'soft')`, [f.periods.novA]), 'APPROVER_NOT_USER');
  });

  it('sealing requires every earlier period sealed', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    await db.query(`select ledger.close_period($1, 'hard')`, [fx.periods.octA]);
    await expectCode(db.query('select ledger.seal_period($1)', [fx.periods.octA]), 'CLOSE_ORDER');
    for (const id of fx.monthsA.slice(0, 9)) await db.query('select ledger.seal_period($1)', [id]);
    await db.query('select ledger.seal_period($1)', [fx.periods.octA]);
  });

  it('a close racing with 10 posting workers: every entry in the period was posted before the close', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    await db.query(`select ledger.close_period($1, 'hard')`, [fx.periods.octA]);
    await db.query(`select ledger.close_period($1, 'soft')`, [fx.periods.novA]);
    // Workers post into soft Nov (controller override) until refused; Nov is hard-closed mid-stream.
    const pool = appPool(11);
    let posted = 0;
    let refused = 0;
    try {
      const worker = async () => {
        const c = await pool.connect();
        try {
          for (let i = 0; i < 2000; i++) {
            try {
              await post(c, dsj(fx, { entry_date: '2026-11-15', allow_soft_close: true }), fx.user1);
              posted++;
            } catch (e) {
              expect((e as Error).message).toMatch(/^PERIOD_CLOSED/);
              refused++;
              return;
            }
          }
        } finally { c.release(); }
      };
      const closer = async () => {
        await new Promise((r) => setTimeout(r, 150));
        const c = await pool.connect();
        try {
          await actAs(c, fx.user1);
          await c.query(`select ledger.close_period($1, 'hard')`, [fx.periods.novA]);
        } finally { c.release(); }
      };
      await Promise.all([...Array.from({ length: 10 }, worker), closer()]);
    } finally {
      await pool.end();
    }
    expect(posted).toBeGreaterThan(0);
    expect(refused).toBe(10); // every worker was eventually refused, so the close landed mid-stream
    await actAs(db, fx.user1);
    const { rows } = await db.query(`
      select (select seq from audit.event where action = 'period.close' and object_id = $1 and detail->>'to' = 'hard') close_seq,
             (select max(a.seq) from audit.event a join ledger.journal_entry j on j.id = a.object_id
               where a.action = 'ledger.post' and j.period_id = $1) last_post_seq,
             (select count(*) from ledger.journal_entry where period_id = $1)::int n`, [fx.periods.novA]);
    expect(rows[0].n).toBe(posted);
    expect(Number(rows[0].last_post_seq)).toBeLessThan(Number(rows[0].close_seq));
  });
});

describe('reopen: two people, never sealed, never out of order', () => {
  it('requester cannot approve; a second person can; the period opens and the event records both', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    const req = (await db.query(`select ledger.request_reopen($1, 'open', 'Missed vendor invoice') id`, [fx.periods.octA])).rows[0].id;
    await expectCode(db.query('select ledger.approve_reopen($1)', [req]), 'SELF_APPROVAL');
    await actAs(db, fx.user2);
    await db.query('select ledger.approve_reopen($1)', [req]);
    const st = (await db.query('select status from period where id = $1', [fx.periods.octA])).rows[0].status;
    expect(st).toBe('open');
    await post(db, dsj(fx, { entry_date: '2026-10-05' })); // no override needed now
    const ev = (await db.query(`select detail from audit.event where action = 'period.reopen' and object_id = $1`, [fx.periods.octA])).rows[0].detail;
    expect(ev).toMatchObject({ from: 'soft', to: 'open', requested_by: fx.user1, approved_by: fx.user2, reason: 'Missed vendor invoice' });
    await actAs(db, fx.user2);
    await expectCode(db.query('select ledger.approve_reopen($1)', [req]), 'REQUEST_DECIDED');
  });

  it('a sealed period never reopens, by request or by a superuser posing as the ledger owner', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    await db.query('select ledger.seal_period($1)', [fx.monthsA[0]]);
    await expectCode(db.query(`select ledger.request_reopen($1, 'open', 'x')`, [fx.monthsA[0]]), 'PERIOD_SEALED');
    const s = await superClient();
    try {
      await s.query('begin');
      await s.query('set local role ledger_owner');
      await s.query(`select set_config('ledger.reopen_period', $1, true)`, [fx.monthsA[0]]);
      await expectCode(s.query(`update period set status = 'hard' where id = $1`, [fx.monthsA[0]]), 'PERIOD_SEALED');
      await s.query('rollback');
      // A hard period, but without the approved-reopen marker: refused even for the ledger owner.
      await s.query('begin');
      await s.query('set local role ledger_owner');
      await expectCode(s.query(`update period set status = 'open' where id = $1`, [fx.monthsA[1]]), 'PERIOD_BACKWARD');
      await s.query('rollback');
    } finally {
      await s.end();
    }
  });

  it('cannot reopen below a later closed period; reopen the later one first', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    // Sep is hard, Oct soft: Sep -> open would put open before soft.
    await expectCode(db.query(`select ledger.request_reopen($1, 'open', 'x')`, [fx.periods.sepA]), 'REOPEN_ORDER');
    const req = (await db.query(`select ledger.request_reopen($1, 'soft', 'x') id`, [fx.periods.sepA])).rows[0].id;
    await actAs(db, fx.user2);
    await db.query('select ledger.approve_reopen($1)', [req]);
    expect((await db.query('select status from period where id = $1', [fx.periods.sepA])).rows[0].status).toBe('soft');
  });

  it('one pending request per period; reject withdraws; a stale request cannot be approved', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    const r1 = (await db.query(`select ledger.request_reopen($1, 'open', 'x') id`, [fx.periods.octA])).rows[0].id;
    await expectCode(db.query(`select ledger.request_reopen($1, 'open', 'again')`, [fx.periods.octA]), 'REOPEN_PENDING');
    await db.query('select ledger.reject_reopen($1)', [r1]);
    const r2 = (await db.query(`select ledger.request_reopen($1, 'open', 'y') id`, [fx.periods.octA])).rows[0].id;
    await db.query(`select ledger.close_period($1, 'hard')`, [fx.periods.octA]); // period moves on
    await actAs(db, fx.user2);
    await expectCode(db.query('select ledger.approve_reopen($1)', [r2]), 'REOPEN_STALE');
    await expectCode(db.query(`select ledger.request_reopen($1, 'open', '  ')`, [fx.periods.novA]), 'BAD_INPUT'); // Nov is open
    await expectCode(db.query(`select ledger.request_reopen($1, 'soft', '  ')`, [fx.periods.octA]), 'MISSING_FIELD');
  });

  it('bookkeepers and agents cannot request or approve; decided requests are frozen', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.clerk);
    await expectCode(db.query(`select ledger.request_reopen($1, 'open', 'x')`, [fx.periods.octA]), 'ROLE_FORBIDDEN');
    await actAs(db, fx.user1);
    const req = (await db.query(`select ledger.request_reopen($1, 'open', 'x') id`, [fx.periods.octA])).rows[0].id;
    await actAs(db, fx.agent);
    await expectCode(db.query('select ledger.approve_reopen($1)', [req]), 'APPROVER_NOT_USER');
    await actAs(db, fx.user1);
    await db.query('select ledger.reject_reopen($1)', [req]);
    await expectCode(su.query(`update ledger.period_reopen set reason = 'edited' where id = $1`, [req]), 'IMMUTABLE');
    await expect(db.query(`update ledger.period_reopen set state = 'approved' where id = $1`, [req])).rejects.toThrow(/permission denied/);
  });
});
