/// <reference types="vite/client" />

import type { DesktopApi } from '@photoallisai/contracts';

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

export {};

