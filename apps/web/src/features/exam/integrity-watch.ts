import { useEffect } from 'react';
import type { SignalReporter } from '@/lib/signals';

/**
 * Watches the exam page itself for help that did not come from the student's own typing.
 *
 * - PAGE_TAMPERED: something not built by ExamOS was put into the page — an AI sidebar, a writing assistant, a
 *   "solve this" overlay, a password manager. Browser extensions do this: they add frames, scripts, custom elements
 *   or load their own files (chrome-extension://…) into the page. ExamOS content lives in #root and in its own dialogs
 *   (marked data-examos-portal); anything else added to the page is reported with what it was and where it came from.
 * - TEXT_NOT_TYPED: answer text that was not typed — put in by a script (an untrusted input event), or a large block
 *   in one go (an assistant's "replace with", a drop, or a field rewritten behind the editor's back).
 *
 * Reports are context for a proctor, never a verdict: dictation, autocorrect and password managers cause some too.
 * Desktop AI apps and "invisible" overlays outside the browser cannot be seen from a web page at all; Safe Exam
 * Browser closes those (DEFAULT_PROHIBITED_APPS) and screen watch shows the screen to a person.
 */
const EXTENSION_SCHEME = /^(chrome|moz|safari-web|ms-browser|edge)-extension:/i;
/** Characters arriving in one input event above this are reported (a long word with autocorrect is far below). */
export const BULK_INSERT_CHARS = 60;

let trusted: (e: Event) => boolean = (e) => e.isTrusted;
/** Tests run in jsdom, where every event is untrusted; they declare user-event's events trusted. */
export function setTrustCheck(fn: (e: Event) => boolean) {
  trusted = fn;
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return EXTENSION_SCHEME.test(u.protocol + ':') || EXTENSION_SCHEME.test(url) ? `${u.protocol}//${u.host}` : u.origin;
  } catch {
    return null;
  }
}
const foreign = (url: string | null | undefined) => {
  const o = originOf(url);
  return !!o && (EXTENSION_SCHEME.test(o) || o !== location.origin);
};

/** What, if anything, about this added element is not ExamOS's own. */
export function classifyAddedElement(el: Element, root: Element | null): { kind: string; tag: string; origin: string | null } | null {
  const tag = el.tagName.toLowerCase();
  const src = el.getAttribute('src') ?? (tag === 'link' ? el.getAttribute('href') : null);
  if (src && EXTENSION_SCHEME.test(src)) return { kind: 'extension-resource', tag, origin: originOf(src) };
  if ((tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object') && (!src || foreign(src) || src.startsWith('about:'))) return { kind: 'frame', tag, origin: originOf(src) };
  if (tag === 'script' && src && foreign(src)) return { kind: 'script', tag, origin: originOf(src) };
  if (tag === 'style' || tag === 'link' || tag === 'script' || tag === 'meta' || tag === 'title' || tag === 'base') return null;
  if (root && root.contains(el)) {
    // inside the app, only a custom element (extensions' own widgets: <grammarly-…>, <monica-…>) is foreign
    return tag.includes('-') ? { kind: 'element', tag, origin: null } : null;
  }
  if (el.closest('[data-examos-portal]')) return null;
  if (el.closest('head')) return null;
  return { kind: tag.includes('-') ? 'element' : 'overlay', tag, origin: null };
}

function fieldName(t: EventTarget | null): string | null {
  if (!(t instanceof HTMLElement)) return null;
  return (t.getAttribute('aria-label') ?? t.id ?? t.getAttribute('name') ?? t.tagName.toLowerCase()).slice(0, 60) || null;
}
const isTextField = (t: EventTarget | null): t is HTMLTextAreaElement | HTMLInputElement | HTMLElement =>
  t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && ['text', 'search', ''].includes(t.type)) || (t instanceof HTMLElement && t.isContentEditable);
const valueOf = (t: HTMLElement) => (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement ? t.value : (t.textContent ?? ''));

export function useIntegrityWatch({ active, reporter, rootId = 'root' }: { active: boolean; reporter: SignalReporter; rootId?: string }) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const root = document.getElementById(rootId);
    const seen = new Set<string>();
    const tampered = (hit: { kind: string; tag: string; origin: string | null }) => {
      const key = `${hit.kind}|${hit.tag}|${hit.origin ?? ''}`;
      if (seen.has(key)) return; // once per kind of thing: an extension re-rendering its widget is one finding
      seen.add(key);
      reporter.report('PAGE_TAMPERED', hit, { force: true });
    };
    const inspect = (node: Node) => {
      if (!(node instanceof Element)) return;
      const hit = classifyAddedElement(node, root);
      if (hit) return tampered(hit);
      for (const child of Array.from(node.querySelectorAll('iframe,frame,embed,object,script[src],link[href],img[src]')).slice(0, 50)) {
        const h = classifyAddedElement(child, root);
        if (h) return tampered(h);
      }
    };
    // what an extension put in before the exam began counts too
    for (const el of Array.from(document.body.children)) inspect(el);
    for (const el of Array.from(document.querySelectorAll('iframe,script[src],link[href]'))) inspect(el);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach(inspect);
        else if (r.type === 'attributes' && r.target instanceof Element) inspect(r.target);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });

    // files an extension loads into the page show up as resources from its own scheme
    let perf: PerformanceObserver | null = null;
    try {
      perf = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (EXTENSION_SCHEME.test(e.name)) tampered({ kind: 'extension-resource', tag: 'resource', origin: originOf(e.name) });
      });
      perf.observe({ type: 'resource', buffered: true });
    } catch {
      perf = null;
    }

    const lengths = new WeakMap<EventTarget, number>();
    const remember = (e: Event) => {
      if (e.target && isTextField(e.target)) lengths.set(e.target, valueOf(e.target).length);
    };
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (!isTextField(ie.target) || !root?.contains(ie.target as Node)) return;
      lengths.set(ie.target, valueOf(ie.target).length);
      const data = ie.data ?? ie.dataTransfer?.getData('text/plain') ?? '';
      const bulk = (['insertReplacementText', 'insertFromDrop', 'insertFromYank'].includes(ie.inputType) && data.length >= 20) || (ie.inputType === 'insertText' && data.length >= BULK_INSERT_CHARS);
      if (bulk && trusted(e)) reporter.report('TEXT_NOT_TYPED', { reason: 'bulk', inputType: ie.inputType, chars: data.length, field: fieldName(ie.target) });
    };
    // An input event the browser did not generate from the student's own keyboard/mouse: a script or extension put
    // the text in (and announced it so the page would save it). The ExamOS editor itself never dispatches these.
    // (A "grew a lot in one keystroke" rule is deliberately not used: the app swaps field contents when the student
    // changes question, which would make it fire on innocent students.)
    const onInput = (e: Event) => {
      if (!isTextField(e.target) || !root?.contains(e.target as Node)) return;
      const now = valueOf(e.target).length;
      const before = lengths.get(e.target) ?? now;
      lengths.set(e.target, now);
      if (!trusted(e)) reporter.report('TEXT_NOT_TYPED', { reason: 'untrusted', chars: Math.max(0, now - before), field: fieldName(e.target) });
    };
    document.addEventListener('focusin', remember, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    return () => {
      observer.disconnect();
      perf?.disconnect();
      document.removeEventListener('focusin', remember, true);
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
    };
  }, [active, reporter, rootId]);
}
