/* On phones the persistent navigation CTA chooses the actual system. Desktop
   and no-JS navigation retain the existing anchor into the page's download area. */
function initDownloadVisibility() {
  const download = document.querySelector<HTMLAnchorElement>('[data-nav-download="auto"]');
  const mobile = matchMedia('(max-width: 760px)');
  const originalHref = download?.getAttribute('href') || '';
  const syncDestination = () => {
    if (!download) return;
    if (mobile.matches) {
      download.dataset.downloadEntry = 'auto';
      download.href = download.dataset.downloadAutoHref || originalHref;
    } else {
      delete download.dataset.downloadEntry;
      download.setAttribute('href', originalHref);
    }
  };
  syncDestination();
  mobile.addEventListener('change', syncDestination);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDownloadVisibility, { once: true });
else initDownloadVisibility();
