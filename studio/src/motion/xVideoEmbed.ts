export const X_VIDEO_ESCAPE_EVENT = 'om-x-video-escape';

export const isXVideoUrl = (url: string) => /^https:\/\/video\.twimg\.com\//i.test(url);

const escapeHtmlAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * X's video CDN returns 403 when requests carry a cross-origin Referer, so play inside a no-referrer srcDoc iframe
 * (same pattern as HubVideoWall). When `dismissToken` is supplied, pressing Escape inside the focused iframe posts a
 * token-scoped message back to the parent dialog so keyboard dismissal keeps working.
 */
export function xVideoDocument(
  src: string,
  poster: string,
  controls: boolean,
  autoPlay: boolean,
  dismissToken?: string,
) {
  const keyBridge = dismissToken
    ? `<script>window.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();window.parent.postMessage({type:${JSON.stringify(X_VIDEO_ESCAPE_EVENT)},token:${JSON.stringify(dismissToken)}},'*');}});</script>`
    : '';
  return `<meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden;background:${controls ? 'black' : 'transparent'}}video{width:100%;height:100%;object-fit:${controls ? 'contain' : 'cover'};display:block}</style><video src="${escapeHtmlAttr(src)}"${controls ? ` poster="${escapeHtmlAttr(poster)}"` : ''} muted${autoPlay ? ' autoplay' : ''} loop playsinline${controls ? ' controls' : ''}></video>${keyBridge}`;
}
