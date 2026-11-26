-- Tenancy, principals, chart of accounts, fiscal periods.
-- Composite (tenant_id, id) / (entity_id, id) unique keys let the ledger use composite
-- foreign keys, so "this account belongs to this tenant" and "this location belongs to
-- this entity" (invariant I2) are enforced structurally, not just by code.

create table tenant (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Every actor that can create or approve an entry: a person, an AI agent, or an integration.
create table principal (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant,
  kind       text not null check (kind in ('user', 'agent', 'integration')),
  name       text not null,
  unique (tenant_id, id)
);

create table entity (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant,
  legal_name       text not null,
  ein              text,
  base_currency    char(3) not null default 'USD',
  default_basis    text not null default 'accrual' check (default_basis in ('accrual', 'cash')),
  fiscal_calendar  text not null default 'calendar_month'
                   check (fiscal_calendar in ('calendar_month', '445', '13_period')),
  unique (tenant_id, id)
);

create table location (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  entity_id         uuid not null,
  name              text not null,
  timezone          text not null default 'America/New_York',
  pos_system        text,
  pos_location_ref  text,
  foreign key (tenant_id, entity_id) references entity (tenant_id, id),
  unique (entity_id, id)
);

create table account (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant,
  number           text not null,
  name             text not null,
  type             text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance   char(1) not null check (normal_balance in ('D', 'C')),
  usar_code        text,
  cash_view        text not null default 'settle' check (cash_view in ('settle', 'always', 'never')),
  is_intercompany  boolean not null default false,
  active           boolean not null default true,
  unique (tenant_id, number),
  unique (tenant_id, id)
);

create table period (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  entity_id   uuid not null,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open', 'soft', 'hard', 'sealed')),
  seal_hash   bytea,
  check (end_date >= start_date),
  foreign key (tenant_id, entity_id) references entity (tenant_id, id),
  unique (entity_id, id),
  -- No two periods of one entity may overlap.
  exclude using gist (entity_id with =, daterange(start_date, end_date, '[]') with &&)
);

-- Accounts are never deleted, and their identity (number, type, normal balance,
-- intercompany flag) never changes once created. Rename or deactivate instead.
create function account_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ACCOUNT_IMMUTABLE: accounts are never deleted; set active = false';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.number <> old.number
     or new.type <> old.type or new.normal_balance <> old.normal_balance
     or new.is_intercompany <> old.is_intercompany then
    raise exception 'ACCOUNT_IMMUTABLE: number, type, normal balance and intercompany flag are fixed';
  end if;
  return new;
end $$;

create trigger account_guard before update or delete on account
  for each row execute function account_guard();

-- Periods only move forward: open -> soft -> hard -> sealed. Dates never change.
-- Sealing is only possible through ledger.seal_period (runs as ledger_owner), which
-- records the chain hash at the moment of sealing.
create function period_guard() returns trigger language plpgsql as $$
declare
  rank_old int := array_position(array['open','soft','hard','sealed'], old.status);
  rank_new int := array_position(array['open','soft','hard','sealed'], new.status);
begin
  if tg_op = 'DELETE' then
    raise exception 'PERIOD_IMMUTABLE: periods are never deleted';
  end if;
  if new.entity_id <> old.entity_id or new.start_date <> old.start_date or new.end_date <> old.end_date then
    raise exception 'PERIOD_IMMUTABLE: period dates and entity are fixed';
  end if;
  if rank_new < rank_old then
    raise exception 'PERIOD_BACKWARD: % -> % is not allowed (reopen requires the reopen workflow)', old.status, new.status;
  end if;
  if old.seal_hash is not null and new.seal_hash is distinct from old.seal_hash then
    raise exception 'PERIOD_IMMUTABLE: seal hash cannot change';
  end if;
  if new.status = 'sealed' and old.status <> 'sealed' and current_user <> 'ledger_owner' then
    raise exception 'PERIOD_SEAL_DIRECT: use ledger.seal_period()';
  end if;
  if new.status = 'sealed' and new.seal_hash is null then
    raise exception 'PERIOD_SEAL_DIRECT: a sealed period needs a seal hash';
  end if;
  return new;
end $$;

create trigger period_guard before update or delete on period
  for each row execute function period_guard();
