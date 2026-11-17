import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export function publicBrandAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a > 0 &&
      a < 224 &&
      ![10, 127].includes(a) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && [0, 168].includes(b)) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && [18, 19].includes(b))
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0:|db8:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
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
type BrandAddress = { address: string; family: number };
const syntheticAddress = (address: string) => /^198\.(?:18|19)\./.test(address);

/** A public resolver handles proxy Fake-IP answers without admitting synthetic/private peers. */
async function publicDns(hostname: string, signal: AbortSignal): Promise<BrandAddress[]> {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'A');
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal,
      headers: { Accept: 'application/dns-json' },
      // Bootstrap the resolver independently of the synthetic OS DNS. TLS still verifies its hostname.
      lookup: (_host, options, done) => {
        if ((options as { all?: boolean }).all) (done as Function)(null, [{ address: '1.1.1.1', family: 4 }]);
        else done(null, '1.1.1.1', 4);
      },
    }, response => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65_536) response.destroy(new Error('Public DNS response is too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Public DNS lookup failed');
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (answer.Status !== 0 || !Array.isArray(answer.Answer)) throw new Error('Public DNS lookup failed');
          resolve(answer.Answer.filter((record: { type: number; data: string }) => record.type === 1)
            .map((record: { data: string }) => ({ address: record.data, family: 4 })));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Public DNS lookup timed out')));
    request.on('error', reject);
  });
}
export async function resolveBrandAddresses(hostname: string, signal: AbortSignal, dependencies = {
  lookup: (name: string) => lookup(name, { all: true }),
  publicDns,
}): Promise<BrandAddress[]> {
  let addresses = await dependencies.lookup(hostname);
  signal.throwIfAborted();
  // Only the well-defined benchmarking/Fake-IP range gets a second resolution path.
  // A loopback, RFC1918, mixed private or link-local DNS answer remains a hard rejection.
  if (addresses.length && addresses.every(({ address }) => syntheticAddress(address)))
    addresses = await dependencies.publicDns(hostname, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicBrandAddress(address)))
    throw new Error('Website points to a private network');
  return addresses;
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
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 OpenMotion-BrandKit/1.0",
          "Accept-Encoding": "identity",
          Accept: "*/*",
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
            if (res.headers["content-encoding"] === "gzip")
              body = gunzipSync(body, options);
            else if (res.headers["content-encoding"] === "br")
              body = brotliDecompressSync(body, options);
            else if (res.headers["content-encoding"] === "deflate")
              body = inflateSync(body, options);
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
