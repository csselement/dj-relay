import { useEffect, useRef } from "react";

export function AnimatedText({ value }: { value: string }) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const initialValue = useRef(value);
  const displayedValue = useRef(value);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || displayedValue.current === value) return;

    const updateImmediately = () => {
      element.textContent = value;
      displayedValue.current = value;
      element.classList.remove("is-exit", "is-enter-start");
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      updateImmediately();
      return;
    }

    const duration = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur"),
    ) || 160;

    element.classList.add("is-exit");
    const timeout = window.setTimeout(() => {
      element.textContent = value;
      displayedValue.current = value;
      element.classList.remove("is-exit");
      element.classList.add("is-enter-start");
      void element.offsetHeight;
      element.classList.remove("is-enter-start");
    }, duration);

    return () => {
      window.clearTimeout(timeout);
      element.classList.remove("is-exit", "is-enter-start");
    };
  }, [value]);

  return <span className="t-text-swap" ref={elementRef}>{initialValue.current}</span>;
}
