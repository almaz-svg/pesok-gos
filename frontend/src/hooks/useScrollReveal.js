import { useEffect, useRef } from 'react';

/** Animate each marked element once; content stays visible without the observer. */
export default function useScrollReveal() {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!root || motion.matches || !('IntersectionObserver' in window)) return;

    const elements = [...root.querySelectorAll('[data-reveal]')];
    const reveal = (element) => {
      element.classList.add('is-revealed');
      observer.unobserve(element);
    };
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && reveal(entry.target)),
      { threshold: 0.12, rootMargin: '0px 0px -20px 0px' },
    );
    elements.forEach((element) => {
      element.classList.add('reveal-ready');
      observer.observe(element);
    });
    const onMotionChange = () => {
      if (motion.matches) elements.forEach(reveal);
    };
    const onFocus = (event) => {
      const element = event.target.closest('[data-reveal]');
      if (element && root.contains(element)) reveal(element);
    };
    motion.addEventListener('change', onMotionChange);
    root.addEventListener('focusin', onFocus);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', onMotionChange);
      root.removeEventListener('focusin', onFocus);
      elements.forEach((element) => element.classList.remove('reveal-ready', 'is-revealed'));
    };
  }, []);

  return rootRef;
}
