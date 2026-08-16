import { useEffect, useState } from "react";

/**
 * `prefers-reduced-motion`, live.
 *
 * The CSS media query in index.css handles CSS transitions, but a GSAP tween
 * and a Framer spring are JS: they set inline transforms every frame and CSS
 * cannot override them. So every React Bits component that MOVES something is
 * handed distance 0 / stagger 0 / duration ~0 from here, which leaves the
 * opacity fade intact. Reduced motion means fewer and gentler, not zero.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * True on a device with a real pointer. Hover effects are gated on this in CSS;
 * this is for the JS-driven ones (GlareHover mounts a mousemove listener and a
 * sweep that a touch device fires on tap and then leaves stuck).
 */
export function useFinePointer(): boolean {
  const [fine, setFine] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return true;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const onChange = () => setFine(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return fine;
}
