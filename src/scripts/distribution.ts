import qrcode from 'qrcode-generator';
import { createDownloadMotion } from './download-motion';
import { decideDownload, detectDevice, distributionPath, isEmbeddedBrowser, parseDownloadRequest,
  type DownloadPlatform, type DownloadRequest, type DownloadUrls } from '../lib/distribution';

const device = detectDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
const embedded = isEmbeddedBrowser(navigator.userAgent);
const dialog = document.querySelector<HTMLDialogElement>('#distribution-dialog');
const card = document.querySelector<HTMLElement>('[data-distribution-card]');
const isPage = !!document.querySelector('[data-distribution-page]');

if (card) {
  const root = card;
  const urls: DownloadUrls = JSON.parse(root.dataset.urls || '{}');
  const messages: Record<string, string> = JSON.parse(root.dataset.messages || '{}');
  const locale = root.dataset.locale || 'en';
  // Keep the existing CTA contract aligned with the destination the phone uses.
  // Unknown/desktop auto choices and unavailable targets are not conversions.
  document.querySelectorAll<HTMLElement>('[data-download-entry]').forEach(entry => {
    const requested = parseDownloadRequest(entry.dataset.downloadEntry);
    const platform = requested === 'h5' ? 'h5' : device === 'ios' || device === 'android'
      ? device : requested === 'auto' ? null : requested;
    if (platform && urls[platform]) entry.dataset.m = `cta:${platform}`;
    else entry.removeAttribute('data-m');
  });
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const title = get('[data-distribution-title]');
  const description = get('[data-distribution-description]');
  const status = get('[data-distribution-status]');
  const action = get<HTMLAnchorElement>('[data-distribution-action]');
  const switchLink = get<HTMLAnchorElement>('[data-distribution-switch]');
  const copyWrap = get('[data-distribution-copy-wrap]');
  const copyButton = get<HTMLButtonElement>('[data-distribution-copy]');
  const copyStatus = get('[data-copy-status]');
  const linkInput = get<HTMLInputElement>('[data-distribution-link]');
  const qrWrap = get('[data-distribution-qr-wrap]');
  const qrElement = get('[data-distribution-qr]');
  const help = get<HTMLDetailsElement>('[data-distribution-help]');
  const note = get('[data-distribution-note]');
  const hoverMedia = window.matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const LEAVE_DELAY = 180;
  const EXIT_DELAY = 360;
  type Interaction = 'hover' | 'focus' | 'click';
  let current: DownloadPlatform = 'android';
  let shareUrl = '';
  let qrVersion = 0;
  let opener: HTMLElement | null = null;
  let anchor: HTMLAnchorElement | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let enterFrame = 0;
  let positionFrame = 0;
  let scrollLocked = false;
  let keyboardEngaged = false;
  let suppressFocusOpen = false;
  let opening = false;
  let restoreAfterClose = false;
  const motion = dialog ? createDownloadMotion(dialog, reducedMotion, () => finishClose()) : null;
  root.dataset.device = device;

  const text = (key: string) => messages[key] || '';
  const setStatus = (message: string) => { status.textContent = message; status.hidden = !message; };
  const setAction = (url: string, label: string) => {
    action.hidden = false;
    action.textContent = label;
    action.toggleAttribute('aria-disabled', !url);
    if (url) { action.href = url; action.removeAttribute('tabindex'); }
    else { action.removeAttribute('href'); action.setAttribute('aria-disabled', 'true'); action.tabIndex = 0; }
  };
  const canPopover = () => device === 'desktop' && hoverMedia.matches && !isPage;
  const isPopover = () => dialog?.open && dialog.dataset.presentation === 'popover';
  const cancelClose = () => {
    clearTimeout(leaveTimer); leaveTimer = undefined;
    clearTimeout(exitTimer); exitTimer = undefined;
    restoreAfterClose = false;
    if (dialog?.open) {
      if (dialog.dataset.open !== 'true') motion?.setOpen(true);
      anchor?.setAttribute('aria-expanded', 'true');
    }
  };
  const restoreFocus = (target: HTMLElement | null) => {
    suppressFocusOpen = true;
    target?.focus({ preventScroll: true });
    suppressFocusOpen = false;
  };
  function finishClose(restore = restoreAfterClose) {
    if (!dialog) return;
    const returnTarget = opener;
    clearTimeout(leaveTimer); leaveTimer = undefined;
    clearTimeout(exitTimer); exitTimer = undefined;
    cancelAnimationFrame(enterFrame);
    motion?.reset();
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
    opener = null;
    dialog.dataset.open = 'false';
    // Native close() restores focus before dispatching its close event. Treat that
    // restoration like our explicit focus return so it cannot disclose the card again.
    suppressFocusOpen = true;
    if (dialog.open) dialog.close();
    suppressFocusOpen = false;
    if (scrollLocked) {
      scrollLocked = false;
      document.dispatchEvent(new Event('x:scroll-unlock'));
    }
    if (restore) restoreFocus(returnTarget);
    restoreAfterClose = false;
  }
  function closeDialog(restore = false) {
    if (!dialog?.open) return;
    clearTimeout(leaveTimer); leaveTimer = undefined;
    clearTimeout(exitTimer);
    cancelAnimationFrame(enterFrame);
    restoreAfterClose = restore;
    anchor?.setAttribute('aria-expanded', 'false');
    exitTimer = setTimeout(() => finishClose(), reducedMotion.matches ? 0 : EXIT_DELAY);
    motion?.setOpen(false);
  }
  const isInside = () => Boolean(anchor?.matches(':hover') || dialog?.matches(':hover')
    || (keyboardEngaged && (document.activeElement === anchor || dialog?.contains(document.activeElement))));
  const scheduleClose = () => {
    if (!isPopover()) return;
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      if (!isInside()) closeDialog();
    }, LEAVE_DELAY);
  };
  function positionPopover() {
    if (!dialog || !isPopover() || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    if (!anchor.isConnected || !anchor.getClientRects().length || rect.bottom < 0 || rect.top > viewportHeight) {
      closeDialog(); return;
    }
    const gutter = 12, gap = 12;
    const width = dialog.offsetWidth || 304;
    const height = Math.min(dialog.offsetHeight, viewportHeight - gutter * 2);
    const below = viewportHeight - rect.bottom - gap - gutter;
    const above = rect.top - gap - gutter;
    const placement = below >= height || below >= above ? 'bottom' : 'top';
    const left = Math.max(gutter, Math.min(rect.left + (rect.width - width) / 2, viewportWidth - width - gutter));
    const top = Math.max(gutter, Math.min(placement === 'bottom' ? rect.bottom + gap : rect.top - gap - height,
      viewportHeight - height - gutter));
    dialog.dataset.placement = placement;
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  }
  const schedulePosition = () => {
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(positionPopover);
  };
  const openDialog = (trigger: HTMLAnchorElement | null = anchor, interaction: Interaction = 'click') => {
    if (!dialog) return;
    const presentation = canPopover() && trigger && root.dataset.state === 'qr' ? 'popover' : 'modal';
    const focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog.open && dialog.dataset.presentation !== presentation) finishClose(false);
    cancelClose();
    cancelAnimationFrame(enterFrame);
    if (anchor !== trigger) anchor?.setAttribute('aria-expanded', 'false');
    anchor = trigger;
    opener = trigger || opener || focusBefore;
    anchor?.setAttribute('aria-expanded', 'true');
    dialog.dataset.presentation = presentation;
    if (presentation === 'modal') {
      dialog.style.removeProperty('left'); dialog.style.removeProperty('top');
      dialog.setAttribute('aria-modal', 'true');
    } else dialog.removeAttribute('aria-modal');
    if (!dialog.open) {
      dialog.dataset.open = 'false';
      opening = true;
      if (presentation === 'popover') dialog.show();
      else {
        dialog.showModal();
        scrollLocked = true;
        document.dispatchEvent(new Event('x:scroll-lock'));
      }
      // Hover and focus disclosure must not steal the keyboard's current target.
      if (presentation === 'popover' && interaction !== 'click') {
        if (focusBefore === document.body && document.activeElement instanceof HTMLElement) document.activeElement.blur();
        else restoreFocus(focusBefore);
      }
      opening = false;
    }
    if (presentation === 'popover') positionPopover();
    else dialog.getBoundingClientRect();
    // Layout above commits the hidden state before the screen opens.
    enterFrame = requestAnimationFrame(() => {
      if (dialog.open && dialog.dataset.open !== 'true') motion?.setOpen(true);
    });
  };
  const navigate = (url: string) => {
    root.dataset.state = 'initiated';
    setStatus(text(current === 'android' ? 'initiatedBody' : current === 'h5' ? 'openingH5Body' : 'continueBody'));
    title.textContent = text(current === 'android' ? 'initiated' : current === 'h5' ? 'openingH5' : 'iosTitle');
    if (current === 'android') { action.textContent = text('retry'); help.open = true; }
    if (current === 'h5' && isPopover()) finishClose(false);
    window.dispatchEvent(new Event('uvel:before-navigate'));
    window.location.assign(url);
  };

  function render(request: DownloadRequest, source: 'button' | 'scan', autoNavigate = false,
    trigger: HTMLAnchorElement | null = anchor, interaction: Interaction = 'click') {
    const decision = decideDownload(request, device, urls, embedded, source);
    current = decision.platform;
    root.dataset.state = decision.kind;
    root.dataset.platform = current;
    get('[data-distribution-edition-label]').textContent = current === 'ios' ? 'iOS' : current === 'android' ? 'Android' : text('webEdition');
    title.textContent = text(`${current}Title`);
    description.textContent = '';
    setStatus('');
    qrWrap.hidden = true;
    qrElement.replaceChildren();
    qrVersion++;
    action.hidden = true;
    action.removeAttribute('href');
    switchLink.hidden = true;
    help.hidden = current !== 'android' || device === 'desktop'
      || decision.kind !== 'navigate';
    help.open = !help.hidden;
    note.hidden = current !== 'android' || decision.kind !== 'navigate';
    copyWrap.hidden = true;
    linkInput.hidden = true;
    copyStatus.textContent = '';
    get('[data-copy-label]').textContent = text('copyLink');
    shareUrl = new URL(distributionPath(locale, current), location.origin).href;
    linkInput.value = shareUrl;
    root.querySelectorAll<HTMLAnchorElement>('.distribution-options [data-distribution-option]').forEach(link => {
      link.setAttribute('aria-current', String(link.dataset.distributionOption === current));
      link.hidden = decision.kind !== 'choose' && link.dataset.distributionOption === current;
    });

    if (decision.kind === 'qr') {
      title.textContent = text('title');
      description.textContent = text(current === 'ios' ? 'scanIos' : 'scanAndroid');
      copyWrap.hidden = false;
      qrWrap.hidden = false;
      try {
        const qr = qrcode(0, 'M');
        qr.addData(shareUrl);
        qr.make();
        // Generated locally: no QR service or third-party request receives the URL.
        qrElement.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
        qrElement.dataset.url = shareUrl;
      } catch {
        qrWrap.hidden = true;
        setStatus(text('qrUnavailable'));
        linkInput.hidden = false;
      }
      if (!decision.url) setStatus(text('unavailableBody'));
    } else if (decision.kind === 'choose') {
      title.textContent = text('unknownTitle');
      description.textContent = text('unknownBody');
    } else if (decision.kind === 'mismatch') {
      title.textContent = text('mismatchTitle');
      description.textContent = text('mismatchBody').replace('{platform}', current === 'ios' ? 'iOS' : 'Android');
      const target = device === 'ios' ? 'ios' : 'android';
      const alternate = get<HTMLAnchorElement>(`.distribution-options [data-distribution-option="${target}"]`);
      switchLink.href = alternate.href;
      switchLink.dataset.distributionOption = target;
      switchLink.textContent = alternate.textContent;
      switchLink.hidden = false;
    } else if (decision.kind === 'unavailable') {
      title.textContent = text(current === 'h5' ? 'h5Unavailable' : 'unavailable');
      description.textContent = text(current === 'h5' ? 'h5UnavailableBody' : 'unavailableBody');
      setAction('', text(current === 'h5' ? 'h5Unavailable' : 'unavailable'));
    } else if (decision.kind === 'browser') {
      title.textContent = text('blockedTitle');
      description.textContent = text(current === 'h5' ? 'blockedH5Body' : device === 'ios' ? 'blockedIosBody' : 'blockedBody');
      copyWrap.hidden = false;
      if (current === 'h5') setAction(decision.url, text('openH5'));
    } else {
      setAction(decision.url, text(current === 'ios' ? 'continueIos' : current === 'h5' ? 'openH5' : 'downloadAndroid'));
      description.textContent = text(current === 'android' ? 'downloadNote' : current === 'h5' ? 'openingH5Body' : 'continueBody');
      if (autoNavigate) {
        // APK downloads can keep the current document. Make its progress/retry
        // guidance visible before handing the request to the browser.
        if (!isPage && current === 'android') openDialog(trigger, interaction);
        navigate(decision.url);
        return;
      }
    }
    if (!isPage) openDialog(trigger, interaction);
  }

  action.addEventListener('click', event => {
    event.preventDefault();
    if (action.getAttribute('aria-disabled') === 'true' || !action.hasAttribute('href')) return;
    navigate(action.href);
  });
  root.addEventListener('click', event => {
    const option = (event.target as Element).closest<HTMLAnchorElement>('[data-distribution-option]');
    if (!option) return;
    event.preventDefault();
    const requested = parseDownloadRequest(option.dataset.distributionOption);
    if (isPage) history.replaceState(null, '', distributionPath(locale, requested));
    render(requested, 'scan', true);
  });
  copyButton.addEventListener('click', async () => {
    const version = qrVersion;
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (version === qrVersion) copyStatus.textContent = text('copied');
    } catch {
      if (version !== qrVersion) return;
      copyStatus.textContent = text('copyFailed');
      linkInput.hidden = false;
      linkInput.focus();
      linkInput.select();
    }
  });
  document.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLAnchorElement>('[data-download-entry]');
    if (!target) {
      if (isPopover() && event.target instanceof Node && !dialog?.contains(event.target)) closeDialog();
      return;
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    keyboardEngaged = event.detail === 0;
    render(parseDownloadRequest(target.dataset.downloadEntry), 'button', true, target);
    if (isPopover() && keyboardEngaged) copyButton.focus({ preventScroll: true });
  });
  if (dialog) {
    document.querySelectorAll<HTMLAnchorElement>('[data-download-entry="ios"], [data-download-entry="android"]').forEach(entry => {
      entry.setAttribute('aria-controls', dialog.id);
      entry.setAttribute('aria-haspopup', 'dialog');
      entry.setAttribute('aria-expanded', 'false');
      const disclose = (interaction: Interaction) => {
        if (!canPopover() || suppressFocusOpen) return;
        keyboardEngaged = interaction === 'focus';
        if (anchor === entry && isPopover()) {
          cancelClose(); entry.setAttribute('aria-expanded', 'true'); schedulePosition(); return;
        }
        render(parseDownloadRequest(entry.dataset.downloadEntry), 'button', false, entry, interaction);
      };
      entry.addEventListener('mouseenter', () => disclose('hover'));
      entry.addEventListener('mouseleave', () => { keyboardEngaged = false; scheduleClose(); });
      entry.addEventListener('focus', () => { if (entry.matches(':focus-visible')) disclose('focus'); });
      entry.addEventListener('blur', scheduleClose);
      entry.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && canPopover()) {
          event.preventDefault(); disclose('focus');
          copyButton.focus({ preventScroll: true });
        }
      });
    });
    dialog.addEventListener('mouseenter', () => {
      if (isPopover()) { keyboardEngaged = false; cancelClose(); anchor?.setAttribute('aria-expanded', 'true'); }
    });
    dialog.addEventListener('mouseleave', () => { keyboardEngaged = false; scheduleClose(); });
    dialog.addEventListener('focusin', () => { if (!opening && isPopover()) cancelClose(); });
    dialog.addEventListener('focusout', scheduleClose);
    get('[data-distribution-close]').addEventListener('click', () => closeDialog(true));
    dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(true); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(true); });
    dialog.addEventListener('close', () => {
      if (!dialog.open) finishClose(false);
    });
    document.addEventListener('pointerdown', () => { keyboardEngaged = false; }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Tab') keyboardEngaged = true;
      if (event.key === 'Escape' && dialog.open) {
        event.preventDefault(); event.stopPropagation(); closeDialog(true);
      }
    }, true);
    window.addEventListener('resize', schedulePosition, { passive: true });
    window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    hoverMedia.addEventListener('change', () => { if (dialog.open) closeDialog(); });
    new ResizeObserver(schedulePosition).observe(dialog);
  }
  if (isPage) {
    const params = new URLSearchParams(location.search);
    const request = parseDownloadRequest(params.get('platform'));
    // Back/forward navigation must not trap users in a redirect or repeat an APK download.
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    render(request, params.get('source') === 'button' ? 'button' : 'scan', navigation?.type !== 'back_forward');
  }
}
