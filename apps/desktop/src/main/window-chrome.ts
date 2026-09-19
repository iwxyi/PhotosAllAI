import type { BrowserWindowConstructorOptions } from 'electron';

export function getWindowChromeOptions(platform: NodeJS.Platform): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition'
> {
  return platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
    : {};
}
