import { useEffect, useRef, useState } from "react";

/**
 * When `when` is false, always mirrors `value` (no debounce).
 * When `when` is true, updates are debounced, except the first update after
 * `when` turns true (so the first chunk paints immediately).
 */
export function useDebouncedValueWhen<T>(value: T, delay: number, when: boolean) {
  const [d, setD] = useState(value);
  const wasWhen = useRef(false);

  useEffect(() => {
    if (!when) {
      wasWhen.current = false;
      setD(value);
      return;
    }
    if (!wasWhen.current) {
      wasWhen.current = true;
      setD(value);
      return;
    }
    const id = setTimeout(() => setD(value), delay);
    return () => clearTimeout(id);
  }, [value, delay, when]);

  return when ? d : value;
}
