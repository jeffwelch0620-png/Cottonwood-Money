'use client';
// Who is signed in (from /v1/me) and which entity the screens are working on.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from './api';

export interface Me {
  tenant_id: string; tenant_name: string; role: string; location_ids: string[] | null;
  approval_limit: string | null; principal_id: string; principal_name: string; kind: string;
}
export interface Entity {
  id: string; legal_name: string; default_basis: 'accrual' | 'cash'; fiscal_calendar: string;
  fy_end_month: number; week_end_dow: number; fy_week_rule: string;
}

interface Ctx {
  me: Me | null; meError: Error | null; meLoading: boolean; reloadMe: () => void;
  entities: Entity[]; reloadEntities: () => void;
  entity: Entity | null; setEntityId: (id: string) => void;
  can: (...roles: string[]) => boolean;
}
const SessionCtx = createContext<Ctx | null>(null);
const ENTITY_KEY = 'ledger.entity';

export function SessionProvider({ children }: { children: ReactNode }) {
  const meQ = useApi<Me>('/v1/me');
  const entQ = useApi<Entity[]>(meQ.data ? '/v1/entities' : null);
  const [entityId, setEntityIdState] = useState<string | null>(null);
  useEffect(() => {
    try { setEntityIdState(localStorage.getItem(ENTITY_KEY)); } catch { /* no storage */ }
  }, []);
  const entities = entQ.data ?? [];
  const entity = entities.find((e) => e.id === entityId) ?? entities[0] ?? null;
  const value = useMemo<Ctx>(() => ({
    me: meQ.data, meError: meQ.error, meLoading: meQ.loading, reloadMe: meQ.reload,
    entities, reloadEntities: entQ.reload, entity,
    setEntityId: (id) => {
      setEntityIdState(id);
      try { localStorage.setItem(ENTITY_KEY, id); } catch { /* no storage */ }
    },
    can: (...roles) => Boolean(meQ.data && roles.includes(meQ.data.role)),
  }), [meQ.data, meQ.error, meQ.loading, meQ.reload, entities, entQ.reload, entity]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
