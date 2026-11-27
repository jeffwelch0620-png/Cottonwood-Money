-- Row-level security on every tenant table. Re-applied each run (drop + create), like grants.
--
-- app_role sees only rows of app.current_tenant(), which is null without a verified,
-- MFA-complete membership, so an unauthenticated session sees nothing.
-- ledger_owner (owner of the SECURITY DEFINER posting functions) reads the public tables
-- through an explicit allow-all policy; those functions do their own tenant checks.
-- Policies use (select fn()) so Postgres evaluates the function once per statement.

-- 1. Enable RLS -------------------------------------------------------------------------
alter table public.tenant           enable row level security;
alter table public.membership       enable row level security;
alter table public.principal        enable row level security;
alter table public.entity           enable row level security;
alter table public.location         enable row level security;
alter table public.account          enable row level security;
alter table public.period           enable row level security;
alter table public.source_document  enable row level security;
alter table ledger.journal_entry    enable row level security;
alter table ledger.journal_line     enable row level security;
alter table ledger.entry_evidence   enable row level security;
alter table ledger.chain_manifest   enable row level security;
alter table audit.event             enable row level security;

-- 2. ledger_owner reads/updates public tables (definer functions) -------------------------
do $$
declare t text;
begin
  foreach t in array array['tenant','membership','principal','entity','location','account','period','source_document'] loop
    execute format('drop policy if exists ledger_owner_all on public.%I', t);
    execute format('create policy ledger_owner_all on public.%I to ledger_owner using (true) with check (true)', t);
  end loop;
end $$;

-- 3. tenant: members read their own; only the owner renames ------------------------------
drop policy if exists tenant_read on public.tenant;
create policy tenant_read on public.tenant for select to app_role
  using (id = (select app.current_tenant()));
drop policy if exists tenant_update on public.tenant;
create policy tenant_update on public.tenant for update to app_role
  using (id = (select app.current_tenant()) and (select app.has_role('owner')))
  with check (id = (select app.current_tenant()));

-- 4. membership and principal: everyone reads the roster; only the owner changes it -------
do $$
declare t text;
begin
  foreach t in array array['membership','principal'] loop
    execute format('drop policy if exists %1$s_read on public.%1$I', t);
    execute format('create policy %1$s_read on public.%1$I for select to app_role
                      using (tenant_id = (select app.current_tenant()))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to app_role
                      with check (tenant_id = (select app.current_tenant()) and (select app.has_role(''owner'')))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update to app_role
                      using (tenant_id = (select app.current_tenant()) and (select app.has_role(''owner'')))
                      with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

-- 5. setup tables: everyone reads; owner or controller writes ----------------------------
do $$
declare t text;
begin
  foreach t in array array['entity','location','account','period'] loop
    execute format('drop policy if exists %1$s_read on public.%1$I', t);
    execute format('create policy %1$s_read on public.%1$I for select to app_role
                      using (tenant_id = (select app.current_tenant()))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to app_role
                      with check (tenant_id = (select app.current_tenant()) and (select app.has_role(''owner'',''controller'')))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update to app_role
                      using (tenant_id = (select app.current_tenant()) and (select app.has_role(''owner'',''controller'')))
                      with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

-- 6. source documents: everyone reads; anyone but a viewer uploads ------------------------
drop policy if exists source_document_read on public.source_document;
create policy source_document_read on public.source_document for select to app_role
  using (tenant_id = (select app.current_tenant()));
drop policy if exists source_document_insert on public.source_document;
create policy source_document_insert on public.source_document for insert to app_role
  with check (tenant_id = (select app.current_tenant())
              and (select app.has_role('owner','controller','bookkeeper','manager','service')));

-- 7. ledger and audit: read only (writes happen only inside the posting functions) --------
drop policy if exists journal_entry_read on ledger.journal_entry;
create policy journal_entry_read on ledger.journal_entry for select to app_role
  using (tenant_id = (select app.current_tenant()));

-- Lines are also limited to the member's locations (null location_ids = all).
drop policy if exists journal_line_read on ledger.journal_line;
create policy journal_line_read on ledger.journal_line for select to app_role
  using (tenant_id = (select app.current_tenant())
         and ((select app.allowed_locations()) is null
              or location_id = any((select app.allowed_locations())::uuid[])));

drop policy if exists entry_evidence_read on ledger.entry_evidence;
create policy entry_evidence_read on ledger.entry_evidence for select to app_role
  using (tenant_id = (select app.current_tenant()));

drop policy if exists chain_manifest_read on ledger.chain_manifest;
create policy chain_manifest_read on ledger.chain_manifest for select to app_role
  using (exists (select 1 from public.entity e
                  where e.id = chain_manifest.entity_id and e.tenant_id = (select app.current_tenant())));

drop policy if exists audit_event_read on audit.event;
create policy audit_event_read on audit.event for select to app_role
  using (tenant_id = (select app.current_tenant()));
