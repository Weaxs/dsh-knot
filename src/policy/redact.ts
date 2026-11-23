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

export function toolInputPreview(value: unknown, token?: string): string | undefined {
  const display = (text: string): string => {
    const masked = token ? text.replaceAll(token, '[REDACTED]') : text;
    return CREDENTIAL_INPUT.test(masked) ? '[REDACTED]' : redactText(masked);
  };
  let preview: string;
  if (typeof value === 'string') preview = display(value).trim();
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = Object.entries(value)
      .filter(([, field]) => ['string', 'number', 'boolean'].includes(typeof field))
      .slice(0, 8)
      .map(([key, field]) => [
        display(key).slice(0, 120),
        SENSITIVE_KEY.test(key) || CREDENTIAL_INPUT.test(`${key}=`)
          ? '[REDACTED]'
          : typeof field === 'string'
            ? display(field).slice(0, 500)
            : field,
      ]);
    if (!fields.length) return undefined;
    preview = JSON.stringify(Object.fromEntries(fields), null, 2);
  } else return undefined;
  return preview.length > 500 ? `${preview.slice(0, 500)}…` : preview || undefined;
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
