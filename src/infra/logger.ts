export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|apikey|api_key|authorization|cookie|set-cookie|access_key|secret_key|private_key|client_secret|pat)/i;

// Dashboard dimensions are registered route templates. Raw paths may carry
// filenames or preview credentials and must still be redacted.
const projectIoTemplates = new Set([
  '/api/projects/:id/file-source', '/api/projects/:id/files/*',
  '/api/projects/:id/text-edits', '/api/projects/:id/text-edits/batch',
]);

const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)([^/\s@]+)(@)/gi;

export function redactString(input: string): string {
  return input.replace(URL_CREDENTIALS_PATTERN, '$1[REDACTED]$3').replace(/(?:om_pt_[\w-]+\.[\w-]+|om_pl_[\w-]{43})/g, '[REDACTED]');
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const code = (value as unknown as { code?: unknown }).code;
    return {
      name: value.name,
      message: redactString(value.message),
      ...(typeof code === 'string' ? { code } : {}),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'path' && typeof entry === 'string' && projectIoTemplates.has(entry)) {
      output[key] = entry;
    } else if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactValue(entry, depth + 1);
    }
  }
  return output;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  sink?: (level: LogLevel, line: string) => void;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const minLevel = options.level ?? 'info';
  const baseBindings = options.bindings ?? {};
  const sink =
    options.sink ??
    ((level: LogLevel, line: string) => {
      if (level === 'error' || level === 'warn') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    });

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const record = redactValue({
      ts: new Date().toISOString(),
      level,
      ...baseBindings,
      ...(fields ?? {}),
      msg,
    });
    sink(level, JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (bindings) =>
      createLogger({
        level: minLevel,
        bindings: { ...baseBindings, ...bindings },
        sink,
      }),
  };
}
