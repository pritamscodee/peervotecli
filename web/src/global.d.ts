import type { InitialAPI } from '@midnightntwrk/dapp-connector-api';
import type { Buffer as BufferType } from 'buffer';

declare global {
  var Buffer: typeof BufferType;
  var process: typeof import('process');
  var global: typeof globalThis;

  interface Window {
    /** Wallets registered by the DApp Connector, keyed by a UUID (never `mnLace`). */
    midnight?: Record<string, InitialAPI>;
    /** Backend API base URL, set inline by the served HTML (defaults to port 3001). */
    PEARPASS_API_URL?: string;
  }
}

export {};