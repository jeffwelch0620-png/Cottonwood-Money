// Integration base (Phase 1 step 1.1): job worker, evidence storage, connectors, sync runs.
export * from './crypto.js';
export * from './evidence-store.js';
export * from './evidence.js';
export * from './sync.js';
export * from './worker.js';
export { samplePos, sampleDay } from './connectors/sample-pos.js';
export { manifestExport } from './connectors/manifest-export.js';

import { samplePos } from './connectors/sample-pos.js';
import { manifestExport } from './connectors/manifest-export.js';
import type { Handler } from './worker.js';

/** Handlers by job: "sync:<connector kind>". */
export const defaultHandlers: Record<string, Handler> = {
  'sync:sample_pos': samplePos,
  'sync:manifest_export': manifestExport,
};
