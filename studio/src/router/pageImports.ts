/** Share in-flight downloads with the route that renders them; a failed warm
 * must not poison a subsequent navigation. No static React or shell imports. */
export function cachedPageImport<T>(importer: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => pending ??= importer().catch(error => {
    pending = undefined;
    throw error;
  });
}

export const loadExplorePage = cachedPageImport(() =>
  import('../motion/ExploreStudios').then(module => ({ default: module.ExploreStudios })),
);
