/* Each child owns its local clock. The native engine composes them at the host markers. */
(() => {
  window.__timelines = window.__timelines || {};
  window.__timelines.main = gsap.timeline({ paused: true });
})();
