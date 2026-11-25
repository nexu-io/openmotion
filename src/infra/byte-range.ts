/** A single HTTP byte range, with an exclusive end suitable for Buffer.subarray. */
export function singleByteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  // Multipart or unknown range units can be served as a complete 200 response.
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  if (start >= end) return null;
  return { start, end, contentRange: `bytes ${start}-${end - 1}/${size}` };
}
