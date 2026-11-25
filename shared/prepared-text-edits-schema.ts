// Public MCP input. The commit service also enforces the file versions and UTF-8 splice boundaries.
const path = { type: 'string', minLength: 1, maxLength: 240 };
const version = { type: 'string', pattern: '^"(sha256|patch):[a-f0-9]{64}"$' };
const observed = { anyOf: [version, { enum: [null] }] };
const integer = { type: 'integer', minimum: 0 };
const splice = { type: 'array', minItems: 3, maxItems: 3,
  prefixItems: [integer, integer, { type: 'string' }], items: false };
const file = (properties: Record<string, unknown>) => ({
  type: 'object', properties: { path, ...properties }, required: ['path', ...Object.keys(properties)], additionalProperties: false,
});

export const preparedTextEditsSchema = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: { type: 'array', minItems: 1, maxItems: 256, items: { oneOf: [
      file({ baseVersion: version, patch: { type: 'array', maxItems: 4096, items: splice } }),
      file({ baseVersion: observed, content: { type: 'string' } }),
    ] } },
    dependencies: { type: 'object', additionalProperties: observed },
    beatAssets: { type: 'array', minItems: 1, maxItems: 256, items: path },
    label: { type: 'string', minLength: 1, maxLength: 256 },
  },
};
