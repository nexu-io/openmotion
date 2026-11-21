/**
 * Constant-memory streaming SHA-256 hasher (FIPS 180-4) for browser File objects.
 *
 * - Files <= 16 MiB with WebCrypto `crypto.subtle` available use hardware-accelerated SubtleCrypto.
 * - Larger files (or non-secure contexts) stream in 4 MiB slices so peak JS heap stays < 5 MiB
 *   even on 500 MiB video files, supporting AbortSignal and progress callbacks.
 */

const SUBTLE_FAST_PATH_MAX_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class IncrementalSha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private readonly buffer = new Uint8Array(64);
  private bufferLen = 0;
  private bytesHashed = 0;
  private readonly w = new Uint32Array(64);

  update(data: Uint8Array): this {
    let offset = 0;
    const len = data.byteLength;
    this.bytesHashed += len;

    if (this.bufferLen > 0) {
      const needed = 64 - this.bufferLen;
      if (len < needed) {
        this.buffer.set(data, this.bufferLen);
        this.bufferLen += len;
        return this;
      }
      this.buffer.set(data.subarray(0, needed), this.bufferLen);
      this.compress(this.buffer, 0);
      this.bufferLen = 0;
      offset = needed;
    }

    while (offset + 64 <= len) {
      this.compress(data, offset);
      offset += 64;
    }

    if (offset < len) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLen = len - offset;
    }
    return this;
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0w = w[i - 15];
      const s0 = ((s0w >>> 7) | (s0w << 25)) ^ ((s0w >>> 18) | (s0w << 14)) ^ (s0w >>> 3);
      const s1w = w[i - 2];
      const s1 = ((s1w >>> 17) | (s1w << 15)) ^ ((s1w >>> 19) | (s1w << 13)) ^ (s1w >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }

  digestHex(): string {
    const padLen = this.bufferLen < 56 ? 56 - this.bufferLen : 120 - this.bufferLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const totalBits = this.bytesHashed * 8;
    const highBits = Math.floor(totalBits / 0x100000000) >>> 0;
    const lowBits = totalBits >>> 0;
    const view = new DataView(tail.buffer);
    view.setUint32(padLen, highBits, false);
    view.setUint32(padLen + 4, lowBits, false);
    this.update(tail);

    const words = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    return words.map((word) => word.toString(16).padStart(8, "0")).join("");
  }
}

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export async function computeFileSha256(
  file: Blob,
  options: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
    chunkBytes?: number;
  } = {},
): Promise<string> {
  const { onProgress, signal, chunkBytes = STREAM_CHUNK_BYTES } = options;
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  if (
    file.size <= SUBTLE_FAST_PATH_MAX_BYTES &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle?.digest === "function"
  ) {
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    onProgress?.(100);
    return bytesToHex(digest);
  }

  const hasher = new IncrementalSha256();
  const total = file.size;
  let offset = 0;
  while (offset < total) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(total, offset + chunkBytes);
    const sliceBuffer = await file.slice(offset, end).arrayBuffer();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    hasher.update(new Uint8Array(sliceBuffer));
    offset = end;
    onProgress?.(total > 0 ? Math.min(100, Math.round((offset / total) * 100)) : 100);
  }
  onProgress?.(100);
  return hasher.digestHex();
}
