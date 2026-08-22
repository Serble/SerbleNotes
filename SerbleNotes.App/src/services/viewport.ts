/**
 * How much of the page the on-screen keyboard is sitting on top of, as a CSS custom property.
 *
 * A browser is supposed to answer this itself: `interactive-widget=resizes-content` in the viewport
 * meta tells the engine to shrink the layout viewport when the keyboard opens, and then `100dvh`, a
 * centred dialog and a modal's `max-height` all mean the part of the screen still visible. Chrome
 * does it. The Android WebView does not - measured on Chrome 151 WebView, `visualViewport.height`
 * drops to 555 while `innerHeight` stays at 891 - because in a WebView it is the app's own window
 * that decides whether the keyboard resizes anything, and Tauri's does not.
 *
 * So the difference between the two viewports is measured and published as `--kb`, and the handful
 * of surfaces that would otherwise sit under the keyboard subtract it. Zero on every desktop.
 */
export function watchKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) {
    return;
  }

  const apply = () => {
    // What is covered at the bottom: the layout viewport, less what is visible, less how far the
    // visible part has been scrolled down inside it. Rounded, or a fractional pixel makes the value
    // change on every scroll and the layout jitter with it.
    const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${covered}px`);
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
