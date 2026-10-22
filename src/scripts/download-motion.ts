/*
 * The soft opacity / scale / blur reveal adapts Magic's puffIn / puffOut (MIT).
 * Copyright (c) 2022 Christian Pucci. See public/licenses/magic-MIT.txt.
 * https://github.com/miniMAC/magic
 * The aperture and light-line choreography are specific to the UVEL glass panel.
 */
export function createDownloadMotion(dialog: HTMLDialogElement, reduced: MediaQueryList, onClosed: () => void) {
  const panel = dialog.querySelector<HTMLElement>('.distribution-panel')!;
  const beam = dialog.querySelector<HTMLElement>('.distribution-boot-glow')!;
  const duration = 440;
  let animations: Animation[] = [];
  let targetOpen = false;
  const reset = () => {
    for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
    animations = [];
  };
  const setOpen = (open: boolean) => {
    targetOpen = open;
    dialog.dataset.open = String(open);
    if (reduced.matches) {
      reset();
      if (!open) onClosed();
      return;
    }
    if (!animations.length) {
      const ease = 'cubic-bezier(.16,1,.3,1)';
      // Animate an inner surface: the pointer corridor and placement box never shrink.
      animations = [
        panel.animate([
          { offset: 0, opacity: 0, clipPath: 'inset(50% 46% round 20px)', transform: 'scale(.97)', filter: 'blur(2px)', easing: 'ease-out' },
          { offset: .16, opacity: 1, clipPath: 'inset(49.6% 6% round 20px)', transform: 'scale(.985)', filter: 'blur(2px)', easing: ease },
          { offset: 1, opacity: 1, clipPath: 'inset(0% 0% round 20px)', transform: 'scale(1)', filter: 'blur(0px)' },
        ], { duration, fill: 'both' }),
        beam.animate([
          { offset: 0, opacity: 0, transform: 'scaleX(.08)' },
          { offset: .14, opacity: .9, transform: 'scaleX(.8)', easing: 'ease-out' },
          { offset: .38, opacity: .32, transform: 'scaleX(1)' },
          { offset: .72, opacity: 0, transform: 'scaleX(1)' },
          { offset: 1, opacity: 0, transform: 'scaleX(1)' },
        ], { duration, fill: 'both' }),
      ];
      for (const animation of animations) { animation.pause(); animation.currentTime = open ? 0 : duration; }
      animations[0].onfinish = () => {
        const closed = !targetOpen;
        // Remove animation styles at rest, leaving the QR at native sharp pixels.
        reset();
        if (closed) onClosed();
      };
    }
    // A quick return reverses the current time instead of restarting or flashing.
    for (const animation of animations) {
      animation.updatePlaybackRate(open ? 1 : -1.45);
      animation.play();
    }
  };
  reduced.addEventListener('change', () => {
    if (!reduced.matches || !animations.length) return;
    reset();
    if (!targetOpen) onClosed();
  });
  return { setOpen, reset };
}
