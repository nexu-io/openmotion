import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeFileSha256, IncrementalSha256 } from "./streamingSha256";

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("streamingSha256", () => {
  it("matches Node crypto SHA-256 across empty, boundary, and multi-block payloads", () => {
    const sizes = [0, 1, 55, 56, 63, 64, 65, 128, 1024, 10_000];
    for (const size of sizes) {
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        payload[i] = (i * 31 + 17) & 0xff;
      }
      const hasher = new IncrementalSha256();
      hasher.update(payload);
      expect(hasher.digestHex()).toBe(nodeSha256(payload));
    }
  });

  it("matches Node crypto SHA-256 when fed irregular chunk splits", () => {
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 13 + 7) & 0xff;
    const hasher = new IncrementalSha256();
    const cuts = [0, 3, 61, 64, 129, 511, 2000, 4096];
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      hasher.update(payload.subarray(cuts[i], cuts[i + 1]));
    }
    expect(hasher.digestHex()).toBe(nodeSha256(payload));
  });

  it("streams Blob slices with progress when subtle crypto is unavailable", async () => {
    const payload = new Uint8Array(256 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 29 + 3) & 0xff;
    const blob = new Blob([payload], { type: "video/mp4" });
    const origCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: origCrypto.randomUUID.bind(origCrypto) },
      configurable: true,
    });
    const progressMarks: number[] = [];
    try {
      const digest = await computeFileSha256(blob, {
        chunkBytes: 64 * 1024,
        onProgress: (p) => progressMarks.push(p),
      });
      expect(digest).toBe(nodeSha256(payload));
      expect(progressMarks.at(-1)).toBe(100);
      expect(progressMarks.length).toBeGreaterThanOrEqual(4);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: origCrypto, configurable: true });
    }
  });
});
