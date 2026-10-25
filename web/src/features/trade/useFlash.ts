// Re-triggers the tick flash animation on an element whenever a live value changes.

import { useEffect, useRef } from 'react';

export function useFlash(value: number | undefined, dir: 1 | -1 | 0) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    const el = ref.current;
    const before = prev.current;
    prev.current = value;
    if (!el || value === undefined || before === undefined || value === before) return;
    el.classList.remove('animate-flash-up', 'animate-flash-down');
    void el.offsetWidth;
    el.classList.add(dir >= 0 ? 'animate-flash-up' : 'animate-flash-down');
  }, [value, dir]);
  return ref;
}
