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
const MAX_REDACTION_CONTEXT = 4_096;
const AUTHORIZATION_TAIL = /\b(Bearer|Basic)\s+([a-zA-Z0-9._~+/=-]*)$/i;

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

export function retainRedactionTail(previous: string, dropped: string): string {
  const source = previous + dropped;
  const authorization = source.length > MAX_REDACTION_CONTEXT ? AUTHORIZATION_TAIL.exec(source) : null;
  if (authorization) {
    // Keep the shape of an open credential without storing an arbitrarily long value.
    return `${authorization[1]} ${'a'.repeat(Math.min(authorization[2]!.length, 12))}`;
  }
  // Copy the short tail so it does not keep the discarded string's backing storage alive.
  return Buffer.from(source.slice(-MAX_REDACTION_CONTEXT), 'utf16le').toString('utf16le');
}

export function redactTextSegments(segments: readonly string[], fullText?: string): string[] {
  if (segments.length === 0) return [];
  const joined = segments.join('');
  // The retained segments can start inside a credential whose prefix was evicted.
  const source = fullText?.endsWith(joined) ? fullText : joined;
  if (segments.length === 1 && source === joined) return [redactText(joined)];
  const spans = PATTERNS.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length })),
  ).sort((a, b) => a.start - b.start);
  let offset = source.length - joined.length;
  let coveredUntil = 0;
  let next = 0;
  return segments.map((segment) => {
    if (!segment) return '';
    const end = offset + segment.length;
    let text = '';
    let cursor = Math.max(offset, coveredUntil);
    for (let span = spans[next]; span && span.start < end; span = spans[++next]) {
      if (span.end <= offset) continue;
      const start = Math.max(span.start, offset);
      if (span.start >= coveredUntil) {
        text += `${source.slice(cursor, start)}[REDACTED]`;
      }
      coveredUntil = Math.max(coveredUntil, span.end);
      cursor = Math.max(cursor, coveredUntil);
    }
    if (cursor < end) text += source.slice(cursor, end);
    offset = end;
    return text;
  });
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
