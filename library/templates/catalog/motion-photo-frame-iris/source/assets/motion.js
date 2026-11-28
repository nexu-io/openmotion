/* The source template registers one seekable GSAP clock. Keep all phases deterministic. */
(() => {
  const root = document.getElementById("film");
  const select = (id) => root.querySelector("#" + id);
  const camera = select("camera");
  const morning = select("morning");
  const framed = select("framed");
  const original = select("original");
  const orb = select("orb");
  const brand = select("brand");
  const tagline = select("tagline");
  const phrases = Array.from(select("subtitle").children);
  const { photoWidth, photoHeight, printWidth, printRatio, photoTop } = root.dataset;
  const printW = Number(printWidth);
  const printH = printW / Number(printRatio);
  const focalY = Number(photoTop) + Number(photoHeight) / 2;
  const startScale = Math.min(1280 / (printW * Number(photoWidth)), 720 / (printH * Number(photoHeight)));
  const length = Number(root.dataset.duration);
  // Percentages describe the actual inner picture on the finished print.
  for (const key of ["photoLeft", "photoTop", "photoWidth", "photoHeight"]) {
    const property = key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
    root.style.setProperty("--" + property, (Number(root.dataset[key]) * 100) + "%");
  }
  root.style.setProperty("--print-width", printW + "px");
  root.style.setProperty("--print-ratio", printW / printH);
  root.style.setProperty("--anchor-offset", (-100 * focalY) + "%");

  function smooth(time, start, end) {
    const u = Math.max(0, Math.min(1, (time - start) / (end - start)));
    return u * u * (3 - 2 * u);
  }
  function render(time) {
    const reveal = smooth(time, 0.50, 1.65);
    const pull = smooth(time, 0.50, 2.20);
    const close = smooth(time, 6.00, 6.68);
    camera.style.transform = "translateY(" + (-42 * pull) + "px) scale(" + (startScale + (1 - startScale) * pull) + ")";
    framed.style.clipPath = "circle(" + (reveal * 83) + "% at 50% " + (focalY * 100) + "%)";
    framed.style.opacity = String(smooth(time, 0.50, 0.70));
    original.style.opacity = String(1 - smooth(time, 1.75, 2.05));
    morning.style.clipPath = "circle(" + (755 * (1 - close)) + "px at 50% 50%)";
    phrases.forEach((word, index) => {
      const appear = smooth(time, 2.2 + index * 0.48, 2.65 + index * 0.48);
      word.style.opacity = String(appear * (1 - smooth(time, 5.55, 5.97)));
      word.style.transform = "translateY(" + ((1 - appear) * 9) + "px)";
    });
    const firstOrb = smooth(time, 0.10, 0.35) * (1 - smooth(time, 0.50, 1.05));
    const lastOrb = smooth(time, 6.42, 6.70);
    orb.style.opacity = String(firstOrb + lastOrb);
    orb.style.transform = "scale(" + (1 + (0.22 * smooth(time, 0.50, 1.05)) * (1 - lastOrb)) + ")";
    const imprint = smooth(time, 6.68, 7.37);
    brand.style.opacity = String(imprint);
    brand.style.transform = "translateY(" + ((1 - imprint) * 12) + "px)";
    tagline.style.opacity = String(smooth(time, 7.10, 7.75) * (1 - smooth(time, 9.65, 10.32)));
  }
  const clock = { time: 0 };
  const timeline = gsap.timeline({ paused: true });
  timeline.to(clock, { time: length, duration: length, ease: "none", onUpdate: () => render(clock.time) }, 0);
  render(0);
  window.__templateScene = { render, fps: Number(root.dataset.fps) };
  window.__timelines = window.__timelines || {};
  window.__timelines.main = timeline;
})();
