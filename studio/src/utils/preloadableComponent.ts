import { createElement, useState, type ComponentProps, type ComponentType } from "react";
import { lazyWithChunkReload } from "./chunkReload";

/** React.lazy suspends on its first render even if a speculative import already
 * finished. Render the ready view synchronously, or use normal Suspense + recovery. */
export function preloadableComponent<T extends ComponentType<any>>(importer: () => Promise<{ default: T }>) {
  let ready: T | undefined;
  const load = () => importer().then(module => {
    ready = module.default;
    return module;
  });
  const Lazy = lazyWithChunkReload(load);
  function Component(props: ComponentProps<T>) {
    // Keep the same component type for the lifetime of an open panel.
    const [View] = useState(() => ready ?? Lazy);
    return createElement(View, props);
  }
  return { Component, load };
}
