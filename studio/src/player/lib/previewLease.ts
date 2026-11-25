import { studioApiFetch } from "../../utils/studioApiFetch";

export function isolatedPreviewOrigin(): string | undefined {
  return typeof document === "undefined" ? undefined :
    document.querySelector<HTMLMetaElement>('meta[name="openmotion-preview-origin"]')?.content;
}

type Grant = { previewOrigin?: string; token: string; expiresAt?: string; assetLease?: string };
type GrantResponse = { status: number; grant: Grant | null };

export interface SharedPreviewGrant {
  readonly origin: string;
  readonly token: string;
  readonly assetLease?: string;
  readonly expiresAt: number;
}

interface InFlightSharedGrant {
  promise: Promise<SharedPreviewGrant>;
  controller: AbortController;
  waiters: number;
}

const SHARED_GRANT_MIN_TTL_MS = 30_000;
const FALLBACK_SHARED_GRANT_TTL_MS = 5 * 60_000;
const sharedGrantsByProject = new Map<string, SharedPreviewGrant>();
const inFlightSharedGrants = new Map<string, InFlightSharedGrant>();

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

function recordSharedGrant(project: string, origin: string, grant: Grant): SharedPreviewGrant {
  const normalizedOrigin = normalizeOrigin(origin);
  const parsedExpiry = typeof grant.expiresAt === "string" ? Date.parse(grant.expiresAt) : NaN;
  const expiresAt =
    Number.isFinite(parsedExpiry) && parsedExpiry > Date.now()
      ? parsedExpiry
      : Date.now() + FALLBACK_SHARED_GRANT_TTL_MS;
  const entry: SharedPreviewGrant = {
    origin: normalizedOrigin,
    token: grant.token,
    ...(typeof grant.assetLease === "string" && grant.assetLease ? { assetLease: grant.assetLease } : {}),
    expiresAt,
  };
  sharedGrantsByProject.set(project, entry);
  return entry;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

/**
 * Reuse the active project's preview token and asset lease across background captures so
 * every capture iframe skips extra `preview-token` round-trips and shares the live preview's
 * `/~assets/<lease>/` browser HTTP cache.
 */
export function acquireSharedPreviewGrant(
  projectId: string,
  previewOrigin: string,
  signal: AbortSignal,
): Promise<SharedPreviewGrant> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const expectedOrigin = normalizeOrigin(previewOrigin);
  const project = encodeURIComponent(projectId);
  const cached = sharedGrantsByProject.get(project);
  if (cached && cached.origin === expectedOrigin && cached.expiresAt - Date.now() > SHARED_GRANT_MIN_TTL_MS) {
    return Promise.resolve(cached);
  }

  const flightKey = `${project}::${expectedOrigin}`;
  let flight = inFlightSharedGrants.get(flightKey);
  if (!flight) {
    const controller = new AbortController();
    const requestPromise = requestPreviewLease(project, expectedOrigin, undefined, controller.signal)
      .then((response) => {
        if (!response.grant || !response.grant.token) {
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            sharedGrantsByProject.delete(project);
          }
          throw new Error(
            response.grant
              ? "Missing preview capture token"
              : `Preview token failed (${response.status})`,
          );
        }
        if (response.grant.previewOrigin && normalizeOrigin(response.grant.previewOrigin) !== expectedOrigin) {
          throw new Error("Invalid preview authorization");
        }
        return recordSharedGrant(project, expectedOrigin, response.grant);
      })
      .finally(() => {
        if (inFlightSharedGrants.get(flightKey)?.promise === requestPromise) {
          inFlightSharedGrants.delete(flightKey);
        }
      });
    flight = { promise: requestPromise, controller, waiters: 0 };
    inFlightSharedGrants.set(flightKey, flight);
  }

  const activeFlight = flight;
  activeFlight.waiters += 1;
  let released = false;
  const releaseWaiter = (abortIfEmpty: boolean) => {
    if (released) return;
    released = true;
    activeFlight.waiters = Math.max(0, activeFlight.waiters - 1);
    if (abortIfEmpty && activeFlight.waiters === 0) {
      activeFlight.controller.abort();
      if (inFlightSharedGrants.get(flightKey) === activeFlight) {
        inFlightSharedGrants.delete(flightKey);
      }
    }
  };

  return awaitWithAbort(activeFlight.promise, signal, () => releaseWaiter(true)).finally(() => {
    releaseWaiter(false);
  });
}

export function invalidateSharedPreviewGrant(projectId: string, token?: string): void {
  const project = encodeURIComponent(projectId);
  const existing = sharedGrantsByProject.get(project);
  if (!existing) return;
  if (!token || existing.token === token) {
    sharedGrantsByProject.delete(project);
  }
}

export function clearSharedPreviewGrantsForTest(): void {
  sharedGrantsByProject.clear();
  for (const flight of inFlightSharedGrants.values()) {
    flight.controller.abort();
  }
  inFlightSharedGrants.clear();
}

async function requestPreviewLease(project: string, origin: string, assetLease: string | undefined, signal: AbortSignal): Promise<GrantResponse> {
  // A new visit still authenticates and obtains its own document grant. Asking the server
  // to renew an existing asset lease preserves the browser cache of versioned project scripts.
  const cached = sharedGrantsByProject.get(project);
  const reusable = cached?.origin === normalizeOrigin(origin) && cached.expiresAt > Date.now() ? cached.assetLease : undefined;
  const response = await studioApiFetch(`/api/projects/${project}/preview-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetLease: assetLease ?? reusable ?? true }),
    priority: "high",
    cache: "no-store",
    signal,
  });
  return { status: response.status, grant: response.ok ? await response.json() : null };
}

/** Grant prefetch and asset URL continuity belong to a single open project. */
export function preparePreviewLease(projectId: string, origin: string, route?: AbortSignal) {
  const project = encodeURIComponent(projectId);
  const signal = route && AbortSignal.any([route, AbortSignal.timeout(10_000)]);
  let pending: Promise<GrantResponse | undefined> | undefined = signal && requestPreviewLease(project, origin, undefined, signal)
    .then((result) => {
      if (!signal.aborted && result.grant?.token && result.grant.previewOrigin === origin &&
          typeof result.grant.expiresAt === "string" && Date.parse(result.grant.expiresAt) > Date.now()) {
        recordSharedGrant(project, origin, result.grant);
      }
      return result;
    })
    .catch(() => undefined);
  signal?.addEventListener("abort", () => { pending = undefined; }, { once: true });
  const scope = {
    project, origin,
    assetLease: undefined as string | undefined,
    takeInitial(): Promise<GrantResponse | undefined> | undefined {
      const response = pending;
      pending = undefined;
      // A newly mounted clip can navigate with this open project's live grant.
      // Match the asset lease as well as the origin so another visit cannot supply its credentials.
      if (!response && !signal?.aborted && scope.assetLease) {
        const cached = sharedGrantsByProject.get(project);
        if (cached?.origin === origin && cached.assetLease === scope.assetLease &&
            cached.expiresAt - Date.now() > SHARED_GRANT_MIN_TTL_MS) {
          return Promise.resolve({ status: 200, grant: {
            previewOrigin: origin, token: cached.token, assetLease: cached.assetLease,
            expiresAt: new Date(cached.expiresAt).toISOString(),
          } });
        }
      }
      return response?.then(result => {
        if (signal?.aborted || !result?.grant || !(Date.parse(result.grant.expiresAt ?? "") > Date.now())) return;
        return result;
      });
    },
  };
  return scope;
}
export type PreparedPreviewLease = ReturnType<typeof preparePreviewLease>;

/** The host renews the asset lease. An uninterrupted lease keeps the current document alive. */
export function bindPreviewLease(
  source: URL,
  origin: string,
  navigate: (url: URL) => void,
  failed: (message: string) => void,
  prepared?: PreparedPreviewLease,
) {
  const project = /^\/api\/projects\/([^/]+)\/preview(?:\/|$)/.exec(source.pathname)?.[1];
  const scope = prepared?.project === project && prepared?.origin === origin ? prepared : undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let pending = false;
  let assetLease: string | undefined;
  let renewAt = 0;
  let expiresAt = 0;
  let navigateOnGrant = false;
  let retryDelay = 1000;

  // Active editors recover within a second. Suspended background viewers can spread over a longer window.
  const recoveryDelay = () => Math.random() * (document.hidden ? 30_000 : 1000);

  function schedule(delay: number, spreadIfSuspended = false) {
    renewAt = Date.now() + delay;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Timers that were originally staggered can all run together after system sleep.
      const now = Date.now();
      if (spreadIfSuspended && now >= expiresAt && now - renewAt > 1000) schedule(recoveryDelay());
      else void renew();
    }, delay);
  }

  async function renew() {
    if (pending || controller.signal.aborted) return;
    clearTimeout(timer);
    pending = true;
    try {
      if (!project) throw new Error("Invalid project preview URL");
      const initial = !assetLease ? scope?.takeInitial() : undefined;
      const early = initial && await initial;
      if (controller.signal.aborted) return;
      const response = early ?? await requestPreviewLease(project, origin, assetLease ?? scope?.assetLease, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.grant) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          assetLease = undefined;
          if (scope) scope.assetLease = undefined;
          sharedGrantsByProject.delete(project);
          renewAt = Infinity;
          failed(`Preview access denied (HTTP ${response.status})`);
          return;
        }
        throw new Error(`Preview authorization failed (HTTP ${response.status})`);
      }
      const grant = response.grant;
      const deadline = Date.parse(grant.expiresAt ?? "");
      const ttl = deadline - Date.now();
      if (grant.previewOrigin !== origin || typeof grant.token !== "string" || !grant.token ||
          typeof grant.assetLease !== "string" || !grant.assetLease || !(ttl > 0)) {
        throw new Error("Invalid preview authorization");
      }
      if (controller.signal.aborted) return;
      recordSharedGrant(project, origin, grant);
      if (navigateOnGrant || assetLease !== grant.assetLease) {
        const url = new URL(source.pathname, origin);
        url.search = source.search;
        url.searchParams.set("pt", grant.token);
        navigate(url);
      }
      assetLease = grant.assetLease;
      if (scope) scope.assetLease = grant.assetLease;
      expiresAt = deadline;
      navigateOnGrant = false;
      retryDelay = 1000;
      // Keep at least one renewal window before expiry, and spread simultaneous viewers over another.
      const windowMs = Math.min(30_000, ttl / 5);
      schedule(ttl - windowMs * (1 + Math.random()), true);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!assetLease) failed(error instanceof Error ? error.message : "Preview authorization failed");
      schedule(retryDelay * (0.5 + Math.random() / 2));
      retryDelay = Math.min(30_000, retryDelay * 2);
    } finally {
      pending = false;
    }
  }

  const wake = () => {
    if (document.hidden || pending || renewAt === Infinity) return;
    const now = Date.now();
    if (now < renewAt && now < expiresAt) return;
    // A reconnect may pull an expired lease out of a long backoff. Repeated
    // online/visibility events must not postpone a recovery already due shortly.
    if (renewAt > now && renewAt - now <= 1000) return;
    schedule(recoveryDelay());
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  void renew();
  return {
    retry() {
      navigateOnGrant = true;
      return renew();
    },
    dispose() {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    },
  };
}
