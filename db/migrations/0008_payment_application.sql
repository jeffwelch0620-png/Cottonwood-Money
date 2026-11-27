-- Payment applications (Phase 0 step 7): which payment settles which document, for how much.
-- They drive the cash-basis view; the accrual ledger is unchanged by them.
--
-- Insert-only. An un-application is a negative row pointing at the row it reverses.
-- settled_on is always the payment entry's date (derived, never a parameter), so cash-basis
-- timing cannot be chosen by the caller.

-- AR document types, alongside the existing AP ones.
alter table ledger.journal_entry drop constraint journal_entry_source_type_check;
alter table ledger.journal_entry add constraint journal_entry_source_type_check check (source_type in
  ('pos_dsj', 'ap_bill', 'ap_payment', 'ar_invoice', 'ar_receipt', 'bank', 'payroll', 'inventory',
   'manual', 'reversal', 'intercompany', 'opening'));

set role ledger_owner;

create table ledger.payment_application (
  id                 uuid primary key default gen_random_uuid(),
  seq                bigint generated always as identity unique,   -- application order
  tenant_id          uuid not null,
  entity_id          uuid not null,
  payment_entry_id   uuid not null,
  document_entry_id  uuid not null,
  amount             numeric(19,4) not null check (amount <> 0),
  settled_on         date not null,
  reverses_id        uuid references ledger.payment_application (id),
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  check ((amount < 0) = (reverses_id is not null)),
  check (payment_entry_id <> document_entry_id),
  foreign key (tenant_id, entity_id, payment_entry_id)  references ledger.journal_entry (tenant_id, entity_id, id),
  foreign key (tenant_id, entity_id, document_entry_id) references ledger.journal_entry (tenant_id, entity_id, id),
  foreign key (tenant_id, created_by) references public.principal (tenant_id, id)
);
create unique index one_unapplication on ledger.payment_application (reverses_id) where reverses_id is not null;
create index payment_application_doc_idx on ledger.payment_application (document_entry_id);
create index payment_application_pay_idx on ledger.payment_application (payment_entry_id);
create index payment_application_entity_idx on ledger.payment_application (entity_id);

create trigger pa_immutable before update or delete on ledger.payment_application
  for each row execute function ledger.forbid_change();
create trigger pa_no_truncate before truncate on ledger.payment_application
  for each statement execute function ledger.forbid_change();

reset role;

grant select on ledger.payment_application to app_role;
