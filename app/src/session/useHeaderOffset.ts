import { useEffect, useState } from "react";

/**
 * The height of the shell's sticky header in CSS pixels, so a bar that sticks below it can use it as its `top`. It follows the header as it wraps or resizes.
 *
 * The shell renders exactly one `header` element, the sticky top bar.
 */
export function useHeaderOffset(): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const header = document.querySelector("header");
    if (header === null) return;
    const measure = () => {
      setOffset(header.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
    };
  }, []);
  return offset;
}
