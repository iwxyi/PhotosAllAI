import { useCallback, useEffect, useRef, useState } from 'react';

export function useTransientNotice(): readonly [string, (message: string) => void] {
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useCallback((message: string) => {
    clearTimeout(timer.current);
    setNotice(message);
    // Restart even when consecutive operations produce the same message.
    timer.current = message ? setTimeout(() => setNotice(''), 5_000) : undefined;
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
  return [notice, showNotice];
}
