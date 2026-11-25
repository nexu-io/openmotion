/**
 * Deterministic canonical JSON serialization for Ed25519 signing and verification.
 *
 * Guarantees byte-identical UTF-8 output across platforms and runtimes:
 * - Object keys are recursively sorted by UTF-16 code unit order (non-locale).
 * - Object properties with `undefined` values are omitted (matching JSON.stringify).
 * - Arrays preserve element order; `undefined` array elements serialize as `null`.
 * - Non-finite numbers (NaN, Infinity, -Infinity), functions, symbols, bigints,
 *   top-level `undefined`, and circular references throw a TypeError.
 */

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function serializeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';

  const valueType = typeof value;
  if (valueType === 'boolean') return value ? 'true' : 'false';
  if (valueType === 'string') return JSON.stringify(value);
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonically serialize non-finite number: ${String(value)}`);
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (valueType !== 'object') {
    throw new TypeError(`Cannot canonically serialize value of type "${valueType}"`);
  }

  const obj = value as Record<string, unknown>;

  if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
    const converted = (obj as { toJSON: () => unknown }).toJSON();
    if (converted === undefined) {
      throw new TypeError('toJSON() returned undefined during canonical serialization');
    }
    return serializeValue(converted, ancestors);
  }

  if (ancestors.has(obj)) {
    throw new TypeError('Cannot canonically serialize circular structure');
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const elements: string[] = [];
      for (let i = 0; i < obj.length; i += 1) {
        const item = obj[i];
        elements.push(item === undefined ? 'null' : serializeValue(item, ancestors));
      }
      return `[${elements.join(',')}]`;
    }

    const keys = Object.keys(obj).sort(compareCodeUnits);
    const entries: string[] = [];
    for (const key of keys) {
      const propValue = obj[key];
      if (propValue === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${serializeValue(propValue, ancestors)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Serializes a JSON-compatible value into deterministic canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('Cannot canonically serialize undefined');
  }
  return serializeValue(value, new Set<object>());
}

/**
 * Serializes a JSON-compatible value into UTF-8 bytes of its canonical JSON representation.
 */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
