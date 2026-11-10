// GSAP + Flip are served locally; the interface remains usable if either script fails.
let indicatorTween, media, gsap;
export function initMotion() {
  gsap = globalThis.gsap;
  if (!gsap) return;
  if (globalThis.Flip) gsap.registerPlugin(globalThis.Flip);
  media = gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)', () => {
    const hover = event => {
      const target = event.target.closest('button:not(:disabled),.device-card .model-image');
      if (target && !target.contains(event.relatedTarget)) gsap.to(target, { scale: 1.025, duration: 0.16, ease: 'power2.out', overwrite: 'auto' });
    };
    const leave = event => {
      const target = event.target.closest('button,.device-card .model-image');
      if (target && !target.contains(event.relatedTarget)) gsap.to(target, { scale: 1, duration: 0.16, ease: 'power2.out', overwrite: 'auto', clearProps: 'transform' });
    };
    const press = event => { const target = event.target.closest('button:not(:disabled)'); if (target) gsap.to(target, { scale: 0.97, duration: 0.1, overwrite: 'auto' }); };
    const release = event => { const target = event.target.closest('button'); if (target) gsap.to(target, { scale: 1, duration: 0.14, overwrite: 'auto', clearProps: 'transform' }); };
    document.addEventListener('pointerover', hover); document.addEventListener('pointerout', leave);
    document.addEventListener('pointerdown', press); document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
    return () => {
      document.removeEventListener('pointerover', hover); document.removeEventListener('pointerout', leave);
      document.removeEventListener('pointerdown', press); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release);
    };
  });
}
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function moveIndicator(previous) {
  const indicator = document.querySelector('.tab-indicator'), active = document.querySelector('[role=tab][aria-selected=true]');
  if (!indicator || !active) return;
  // Flip measures the tab width; scale and translate carry the change.
  if (previous && gsap && globalThis.Flip && !reduced()) {
    indicator.style.left = `${previous.left}px`; indicator.style.width = `${previous.width}px`;
    const state = Flip.getState(indicator);
    indicator.style.left = `${active.offsetLeft}px`; indicator.style.width = `${active.offsetWidth}px`;
    indicatorTween?.kill(); indicatorTween = Flip.from(state, { duration: 0.2, ease: 'power2.out', scale: true });
  } else { indicator.style.left = `${active.offsetLeft}px`; indicator.style.width = `${active.offsetWidth}px`; }
}
export function indicatorPosition() {
  const active = document.querySelector('[role=tab][aria-selected=true]');
  return active ? { left: active.offsetLeft, width: active.offsetWidth } : null;
}
export function feedback(target, kind = 'dialog') {
  if (!gsap || reduced() || !target) return;
  gsap.killTweensOf(target);
  if (kind === 'image') gsap.fromTo(target, { opacity: 0.7 }, { opacity: 1, duration: 0.18, clearProps: 'opacity' });
  else gsap.fromTo(target, { y: kind === 'menu' ? -8 : 6, opacity: 0.7 }, { y: 0, opacity: 1, duration: 0.18, ease: 'power2.out', clearProps: 'transform,opacity' });
}
addEventListener('pagehide', () => { indicatorTween?.kill(); media?.revert(); });
