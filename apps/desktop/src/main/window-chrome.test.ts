import { describe, expect, it } from 'vitest';

import { getWindowChromeOptions } from './window-chrome';

describe('window chrome options', () => {
  it('uses inset traffic lights on macOS', () => {
    expect(getWindowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 }
    });
  });

  it('keeps native system controls on Windows and Linux', () => {
    expect(getWindowChromeOptions('win32')).toEqual({});
    expect(getWindowChromeOptions('linux')).toEqual({});
  });
});
