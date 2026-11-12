import { useLayoutEffect, useRef, type RefObject } from 'react';

/** The one fill behind a row of tabs (class "tab-fill"). It takes the chosen tab's place and size at once and
 *  travels there from the tab it left by transform alone, in --dur-slide. With reduced motion it does not travel. */
export function useTabFill(row: RefObject<HTMLElement | null>, chosen: string) {
  const last = useRef<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const place = (travel: boolean) => {
      const tab = element.querySelector<HTMLElement>(':scope > [aria-selected="true"], :scope > [aria-pressed="true"], :scope > .on');
      if (!tab) return;
      const next = { x: tab.offsetLeft, w: tab.offsetWidth }, from = last.current;
      element.style.setProperty('--fill-x', `${next.x}px`);
      element.style.setProperty('--fill-w', `${next.w}px`);
      last.current = next;
      if (!travel || !from || !next.w || (from.x === next.x && from.w === next.w) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const style = getComputedStyle(element);
      element.animate([{ transform: `translateX(${from.x - next.x}px) scaleX(${from.w / next.w})` }, { transform: 'none' }],
        { pseudoElement: '::before', duration: parseFloat(style.getPropertyValue('--dur-slide')) || 240, easing: style.getPropertyValue('--ease').trim() || 'ease-out' });
    };
    place(true);
    const watch = new ResizeObserver(() => place(false));
    watch.observe(element);
    return () => watch.disconnect();
  }, [row, chosen]);
}
