/**
 * Runtime platform helpers shared across Electron, Capacitor, and the iOS
 * WKWebView host.
 */

/**
 * True when the renderer is running inside iOS WebKit (the native iOS app's
 * WKWebView or any iPhone/iPad/iPod browser). Used to gate features that have
 * patchy or recent support in iOS Safari/WKWebView -- notably
 * `content-visibility: auto`, which only landed in iOS 18 and still has
 * rougher edges than Chromium when text selection extends past the viewport.
 */
export function isAppleMobileWebKit(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator?.userAgent ?? '';
  return /iPhone|iPad|iPod/.test(ua);
}
