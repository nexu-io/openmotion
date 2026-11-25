import { mountOpenDesignLoading } from '../../packages/design-system/loading';

// Mount the OpenDesign pixel-scan startup animation immediately on the pre-JS
// shell mark while the main Studio bundle is still downloading, and dispose it
// as soon as React replaces #root.
const root = document.getElementById('root');
const mark = root?.querySelector<HTMLElement>('.motion-loading > .motion-loading-mark');

if (root && mark) {
  const dispose = mountOpenDesignLoading(mark);
  const observer = new MutationObserver(() => {
    if (!mark.isConnected) {
      observer.disconnect();
      dispose();
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}
