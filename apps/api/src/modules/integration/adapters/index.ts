import type { ErpAdapter } from './types.js';
import { UosAdapter } from './uos.js';
import { GenericRestAdapter } from './generic-rest.js';

export * from './types.js';
export * from './uos.js';
export * from './generic-rest.js';

export function getErpAdapter(provider: string): ErpAdapter {
  const norm = provider.trim().toLowerCase();
  if (norm === 'uos') {
    return new UosAdapter();
  }
  if (norm === 'generic-rest' || norm === 'sap' || norm === 'ellucian') {
    return new GenericRestAdapter();
  }
  throw new Error(`Unsupported ERP provider: ${provider}`);
}

