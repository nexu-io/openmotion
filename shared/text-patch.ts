// All offsets refer to the same original UTF-8 file, including its BOM and line endings.
export type TextSplice = readonly [offsetBytes: number, deleteBytes: number, insert: string];
export type TextPatch = readonly TextSplice[];
export const TEXT_PATCH_BASE_HEADER = 'X-OpenMotion-Base-Version';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Validate the wire grammar without materializing the original file. */
export function validateTextPatchStructure(patch: unknown, baseBytes: number, maxBytes = Infinity): number {
  if (!Array.isArray(patch) || !Number.isSafeInteger(baseBytes) || baseBytes < 0) throw new RangeError('Invalid text patch');
  let previousEnd = 0;
  let previousStart = -1;
  let size = baseBytes;
  for (const splice of patch) {
    if (!Array.isArray(splice) || splice.length !== 3) throw new RangeError('Invalid replacement');
    const [start, count, insert] = splice;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0 ||
        start <= previousStart || start < previousEnd || start > baseBytes || count > baseBytes - start ||
        typeof insert !== 'string' || !insert.isWellFormed() || insert.includes('\0') || (!count && !insert)) {
      throw new RangeError('Invalid text patch');
    }
    previousStart = start;
    previousEnd = start + count;
    size += encoder.encode(insert).length - count;
  }
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new RangeError('Patched file exceeds size limit');
  return size;
}

export function applyTextPatch(source: string, patch: unknown, maxBytes = Infinity): string {
  if (!source.isWellFormed()) throw new RangeError('Invalid UTF-8 source');
  if (Array.isArray(patch) && patch.length === 0 && maxBytes === Infinity) return source;
  return decoder.decode(applyTextPatchBytes(encoder.encode(source), patch, maxBytes));
}

/** Apply a patch to validated UTF-8 bytes without decoding/re-encoding the full source. */
export function applyTextPatchBytes(base: Uint8Array, patch: unknown, maxBytes = Infinity): Uint8Array {
  const result = new Uint8Array(validateTextPatchStructure(patch, base.length, maxBytes));
  const boundary = (offset: number) => (base[offset] & 0xc0) !== 0x80;
  let input = 0, output = 0;
  for (const [start, count, insert] of patch as TextPatch) {
    if (!boundary(start) || !boundary(start + count)) throw new RangeError('Replacement splits a UTF-8 character');
    result.set(base.subarray(input, start), output);
    output += start - input;
    const bytes = encoder.encode(insert);
    result.set(bytes, output);
    output += bytes.length;
    input = start + count;
  }
  result.set(base.subarray(input), output);
  return result;
}
