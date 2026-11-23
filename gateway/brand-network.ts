import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isPublicAddress, publicDns, resolvePublicAddresses, type ResolvedAddress } from "./network.ts";

// Brand capture and provider traffic must agree on what counts as a public address.
export const publicBrandAddress = isPublicAddress;
export function brandWebsite(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048)
    throw new Error("Enter a public HTTPS website");
  const url = new URL(
    raw.includes("://") ? raw.trim() : "https://" + raw.trim(),
  );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    hostname === "localhost" ||
    /\.(?:localhost|local|internal)$/.test(hostname) ||
    (isIP(hostname) && !publicBrandAddress(hostname))
  )
    throw new Error("Enter a public HTTPS website");
  url.hash = "";
  return url.href;
}
export type BrandResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};
type BrandAddress = ResolvedAddress;
export async function resolveBrandAddresses(hostname: string, signal: AbortSignal, dependencies = {
  lookup: (name: string) => lookup(name, { all: true }),
  publicDns,
}): Promise<BrandAddress[]> {
  return resolvePublicAddresses(hostname, signal, 'Website points to a private network', dependencies);
}
const defaultUserAgent = "Mozilla/5.0 OpenMotion-BrandKit/1.0";
const browserUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function fetchWithAgent(
  url: URL,
  addresses: BrandAddress[],
  signal: AbortSignal,
  userAgent: string,
  limit: number,
): Promise<BrandResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        signal,
        headers: {
          "User-Agent": userAgent,
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        },
        lookup: (_host, options, done) => {
          if ((options as { all?: boolean }).all)
            (done as Function)(null, addresses);
          else done(null, addresses[0].address, addresses[0].family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit)
            res.destroy(new Error("Website resource is too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            let body = Buffer.concat(chunks);
            const options = { maxOutputLength: limit };
            const encoding = typeof res.headers["content-encoding"] === "string"
              ? res.headers["content-encoding"].trim().toLowerCase()
              : "";
            if (body.length) {
              if (encoding === "gzip")
                body = gunzipSync(body, options);
              else if (encoding === "br")
                body = brotliDecompressSync(body, options);
              else if (encoding === "deflate")
                body = inflateSync(body, options);
            }
            const headers: Record<string, string> = {};
            for (const key of [
              "content-type",
              "location",
              "access-control-allow-origin",
            ])
              if (typeof res.headers[key] === "string")
                headers[key] = res.headers[key];
            resolve({ status: res.statusCode || 502, headers, body });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(12_000, () =>
      req.destroy(new Error("Website request timed out")),
    );
    req.on("error", reject);
  });
}

/** Every browser request is fulfilled through this bounded, DNS-pinned transport. */
export async function fetchBrandResource(
  raw: string,
  signal: AbortSignal,
  resolveAddresses = resolveBrandAddresses,
): Promise<BrandResponse> {
  const url = new URL(brandWebsite(raw)),
    hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolveAddresses(hostname, signal);
  const limit = 5 * 1024 * 1024;
  const response = await fetchWithAgent(url, addresses, signal, defaultUserAgent, limit);
  // Keep the honest default UA first so Akamai/TLS checks don't tarpit,
  // and retry once with a browser UA only when a host immediately rejects with 403/406.
  if ((response.status === 403 || response.status === 406) && !signal.aborted) {
    try {
      const retry = await fetchWithAgent(url, addresses, signal, browserUserAgent, limit);
      if (retry.status < 400) return retry;
    } catch { /* Preserve the original status when retry fails or times out. */ }
  }
  return response;
}
