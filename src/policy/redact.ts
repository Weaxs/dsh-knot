const PATTERNS: RegExp[] = [
  /\b(?:sk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
  /\b(?:gh[pousr]_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(?:Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]{12,}/gi,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
  /\b(?:set-cookie|cookie)\s*:\s*[^\s]{8,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const SENSITIVE_KEY =
  /^(?:authorization|x[-_]api[-_]key|cookie|set[-_]cookie|password|passwd|secret|client[-_]secret|api[-_]?key|private[-_]?key|(?:access|refresh|session|auth|id)?[-_]?token)$/i;

const CREDENTIAL_INPUT =
  /(?:(?:\b|[_-])(?:authorization|api[-_]?key|token|password|passwd|secret|cookie)["']?\s*[:=]|--[\w-]*(?:key|token|password|passwd|secret)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

const MAX_PREVIEW_LENGTH = 500;
const MAX_PREVIEW_ITEMS = 8;
const MAX_PREVIEW_DEPTH = 3;

export function toolInputPreview(value: unknown, token?: string): string | undefined {
  const display = (text: string): string => {
    const masked = token ? text.replaceAll(token, '[REDACTED]') : text;
    return CREDENTIAL_INPUT.test(masked) ? '[REDACTED]' : redactText(masked);
  };
  const previewValue = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') return display(input).slice(0, MAX_PREVIEW_LENGTH);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (!input || typeof input !== 'object') return undefined;
    if (depth >= MAX_PREVIEW_DEPTH) return '…';
    if (Array.isArray(input)) {
      return input.slice(0, MAX_PREVIEW_ITEMS).map((item) => previewValue(item, depth + 1));
    }
    const fields: Array<[string, unknown]> = [];
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      const field = (input as Record<string, unknown>)[key];
      const item =
        field != null && (SENSITIVE_KEY.test(key) || CREDENTIAL_INPUT.test(`${key}=`))
          ? '[REDACTED]'
          : previewValue(field, depth + 1);
      if (item === undefined) continue;
      fields.push([display(key).slice(0, 120), item]);
      if (fields.length >= MAX_PREVIEW_ITEMS) break;
    }
    return fields.length ? Object.fromEntries(fields) : undefined;
  };
  const preview = typeof value === 'string' ? display(value).trim() : JSON.stringify(previewValue(value, 0), null, 2);
  return preview && preview.length > MAX_PREVIEW_LENGTH
    ? `${preview.slice(0, MAX_PREVIEW_LENGTH)}…`
    : preview || undefined;
}

export function redactText(text: string): string {
  return PATTERNS.reduce((value, pattern) => value.replace(pattern, '[REDACTED]'), text);
}

export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]' as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (SENSITIVE_KEY.test(key)) return [key, '[REDACTED]'];
      return [key, redact(item, seen)];
    }),
  ) as T;
}
