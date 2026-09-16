import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { parseFieldTarget } from './field-target';

/** Reveal the page/group/item first, then focus the exact language field once it is rendered. */
export function useFocusField(reveal?: (target: ReturnType<typeof parseFieldTarget>) => void, ready = true): void {
  const { search, key } = useLocation();
  const latestReveal = useRef(reveal);
  latestReveal.current = reveal;
  useEffect(() => {
    const want = new URLSearchParams(search).get('focus');
    if (!want || !ready) return;
    const target = parseFieldTarget(want);
    latestReveal.current?.(target);
    let finished = false;
    let flash: HTMLElement | undefined;
    const find = (path: string) => Array.from(document.querySelectorAll<HTMLElement>('[data-field], [data-field-alt]'))
      .find((node) => node.dataset.field === path || node.dataset.fieldAlt === path);
    const attempt = () => {
      if (finished) return;
      let element = find(target.canonical) ?? find(want);
      // A language-specific link must never silently land in the first language or a selector.
      if (!element && !target.locale) {
        const segments = target.canonical.split('.');
        while (!element && segments.length > 1) { segments.pop(); element = find(segments.join('.')); }
      }
      if (!element) return;
      const input = element.matches('input, textarea, select, button') ? element : element.querySelector<HTMLElement>('input:not([readonly]):not(:disabled), textarea:not([readonly]):not(:disabled), select:not(:disabled), button:not(:disabled)');
      if (!input) return;
      finished = true;
      observer.disconnect();
      element.scrollIntoView({ block: 'center' });
      element.classList.add('focus-flash');
      flash = element;
      input.focus();
    };
    const observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-field', 'data-field-alt', 'disabled', 'readonly'] });
    const initial = window.setTimeout(attempt, 0);
    const end = window.setTimeout(() => {
      observer.disconnect();
      flash?.classList.remove('focus-flash');
      if (!finished) console.warn(`[focus] 页面上找不到字段:${want}`);
    }, 2400);
    return () => { observer.disconnect(); window.clearTimeout(initial); window.clearTimeout(end); flash?.classList.remove('focus-flash'); };
  }, [search, key, ready]);
}
