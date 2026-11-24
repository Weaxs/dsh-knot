const PRIVATE_KEY = /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?(?:(-----END \1-----)|(?![\s\S]))/g;

const PATTERNS = {
  token: /\b(?:sk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
  github: /\bgh[pousr]_[a-zA-Z0-9_]{20,}\b/g,
  aws: /\bAKIA[0-9A-Z]{16}\b/g,
  authorization: /\b(?:Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]{12,}/gi,
  jwt: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
  cookie: /\b(?:set-cookie|cookie)\s*:\s*[^\s]{8,}/gi,
  privateKey: PRIVATE_KEY,
};

type CredentialKind = keyof typeof PATTERNS;
const CREDENTIAL_KINDS = Object.keys(PATTERNS) as CredentialKind[];
const CONTINUATIONS = new Map(
  CREDENTIAL_KINDS.map((kind) => [kind, new RegExp(PATTERNS[kind].source, PATTERNS[kind].flags.replace('g', 'y'))]),
);

export interface RedactionContext {
  readonly suffix: string;
  readonly shapes: ReadonlyMap<CredentialKind, readonly string[]>;
}

const SENSITIVE_KEY =
  /^(?:authorization|x[-_]api[-_]key|cookie|set[-_]cookie|password|passwd|secret|client[-_]secret|api[-_]?key|private[-_]?key|(?:access|refresh|session|auth|id)?[-_]?token)$/i;

const CREDENTIAL_INPUT =
  /(?:(?:\b|[_-])(?:authorization|api[-_]?key|token|password|passwd|secret|cookie)["']?\s*[:=]|--[\w-]*(?:key|token|password|passwd|secret)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

const MAX_PREVIEW_LENGTH = 500;
const MAX_PREVIEW_ITEMS = 8;
const MAX_PREVIEW_DEPTH = 3;
const TOKEN_TAILS = [
  { kind: 'cookie', opener: /\b(?:set-cookie|cookie)\s*:\s*/gi, terminator: /\s/, minimumLength: 8 },
  { kind: 'authorization', opener: /\b(?:Bearer|Basic)\s+/gi, terminator: /[^a-zA-Z0-9._~+/=-]/, minimumLength: 12 },
  { kind: 'token', opener: /\b(?:sk|api|key|token|secret)[-_]/gi, terminator: /[^a-zA-Z0-9_-]/, minimumLength: 12 },
  { kind: 'github', opener: /\bgh[pousr]_/g, terminator: /[^a-zA-Z0-9_]/, minimumLength: 20 },
] as const;
const JWT_CHARACTER = /[a-zA-Z0-9_-]/;
const WORD_CHARACTER = /[a-zA-Z0-9_]/;
const COOKIE_LABEL = /\b(?:set-cookie|cookie)\s+$/i;
const FOLDED_OPENERS = openerFragments([
  'sk',
  'api',
  'key',
  'token',
  'secret',
  'bearer',
  'basic',
  'set-cookie',
  'cookie',
]);
const EXACT_OPENERS = openerFragments([
  'ghp',
  'gho',
  'ghu',
  'ghs',
  'ghr',
  'AKIA',
  'eyJ',
  ...['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY'].map(
    (label) => `-----BEGIN ${label}-----`,
  ),
]);
const MAX_OPENER_LENGTH = Math.max(...[...EXACT_OPENERS, ...FOLDED_OPENERS].map((part) => part.length));

function openerFragments(openers: readonly string[]): Set<string> {
  return new Set(openers.flatMap((opener) => Array.from({ length: opener.length }, (_, i) => opener.slice(0, i + 1))));
}

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
  return redactTextSegments([text])[0]!;
}

// Do not let short context strings keep the discarded text's backing storage alive.
function copyText(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

function privateKeyTail(source: string): string | undefined {
  for (const match of source.matchAll(PRIVATE_KEY)) {
    if (match[2]) continue;
    const footer = `-----END ${match[1]}-----`;
    // A matching footer can itself be split at the eviction boundary.
    let length = footer.length - 1;
    while (length && !source.endsWith(footer.slice(0, length))) length--;
    return copyText(`-----BEGIN ${match[1]}-----${footer.slice(0, length)}`);
  }
}

function tokenTail(source: string, { opener, terminator, minimumLength }: (typeof TOKEN_TAILS)[number]) {
  let start = source.length;
  while (start > 0 && !terminator.test(source[start - 1]!)) start--;
  for (const match of source.matchAll(opener)) {
    const valueStart = match.index + match[0].length;
    if (valueStart >= start) {
      return copyText(
        `${match[0].replace(/\s+/g, ' ')}${'a'.repeat(Math.min(source.length - valueStart, minimumLength))}`,
      );
    }
  }
}

function jwtTails(source: string): Map<number, string> {
  // Each of the last three components can begin a distinct, still-open JWT.
  const ends = [source.length];
  let start = source.length;
  while (start > 0) {
    const char = source[start - 1]!;
    if (char === '.') {
      if (ends.length === 3) break;
      ends.unshift(start - 1);
    } else if (!JWT_CHARACTER.test(char)) break;
    start--;
  }
  const shapes = new Map<number, string>();
  for (const match of source.slice(start).matchAll(/\beyJ/g)) {
    let partStart = start + match.index + match[0].length;
    const lengths = [];
    for (const end of ends) {
      if (end < partStart) continue;
      lengths.push(end - partStart);
      partStart = end + 1;
    }
    if (shapes.has(lengths.length) || lengths.slice(0, -1).some((length) => length < 8)) continue;
    shapes.set(lengths.length, `eyJ${lengths.map((length) => 'a'.repeat(Math.min(length, 8))).join('.')}`);
  }
  return shapes;
}

function partialCredentialOpener(source: string): string {
  const cookie = COOKIE_LABEL.exec(source);
  if (cookie) return `${cookie[0].trim().toLowerCase()} `;
  for (let start = Math.max(0, source.length - MAX_OPENER_LENGTH); start < source.length; start++) {
    if (source[start] !== '-' && start > 0 && WORD_CHARACTER.test(source[start - 1]!)) continue;
    const fragment = source.slice(start);
    if (EXACT_OPENERS.has(fragment)) return copyText(fragment);
    const folded = fragment.toLowerCase();
    if (FOLDED_OPENERS.has(folded)) return copyText(folded);
  }
  // Keep the word boundary without retaining the previous character's value.
  return WORD_CHARACTER.test(source.at(-1) ?? '') ? 'z' : '';
}

function awsTail(source: string): string | undefined {
  const match = /\bAKIA([0-9A-Z]{0,15})$/.exec(source.slice(-21));
  if (match) return `AKIA${'A'.repeat(match[1]!.length)}`;
}

export function retainRedactionTail(previous: RedactionContext | undefined, dropped: string): RedactionContext {
  const literal = (previous?.suffix ?? '') + dropped;
  const shapes = new Map<CredentialKind, string[]>();
  const priorKey = previous?.shapes.get('privateKey')?.[0];
  const privateKey = privateKeyTail(priorKey ? priorKey + dropped : literal);
  if (privateKey) {
    shapes.set('privateKey', [privateKey]);
    return { suffix: '', shapes };
  }
  // Keep each grammar's continuation independently. One match can contain another grammar's opener.
  for (const grammar of TOKEN_TAILS) {
    const prior = previous?.shapes.get(grammar.kind)?.[0];
    const shape = (prior ? tokenTail(prior + dropped, grammar) : undefined) ?? tokenTail(literal, grammar);
    if (shape) shapes.set(grammar.kind, [shape]);
  }
  const priorAws = previous?.shapes.get('aws')?.[0];
  const aws = awsTail(priorAws ? priorAws + dropped : literal);
  if (aws) shapes.set('aws', [aws]);
  const jwt = jwtTails(literal);
  for (const prior of previous?.shapes.get('jwt') ?? []) {
    for (const [parts, shape] of jwtTails(prior + dropped)) {
      if (shape.length > (jwt.get(parts)?.length ?? 0)) jwt.set(parts, shape);
    }
  }
  if (jwt.size) shapes.set('jwt', [...jwt.values()]);
  return { suffix: partialCredentialOpener(literal), shapes };
}

type Span = { start: number; end: number };

function maskSpans(source: string, pattern: RegExp, offset: number): Span[] {
  const spans: Span[] = [];
  // Consume a JWT's first component once rather than retrying the whole run at each embedded opener.
  const jwtTail = pattern === PATTERNS.jwt ? /\.[\w-]{8,}\.[\w-]{8,}\b/y : undefined;
  for (const match of source.matchAll(jwtTail ? /\beyJ[\w-]{8,}/g : pattern)) {
    let end = match.index + match[0].length;
    if (jwtTail) {
      jwtTail.lastIndex = end;
      if (!jwtTail.test(source)) continue;
      end = jwtTail.lastIndex;
    }
    end -= offset;
    if (end > 0) spans.push({ start: Math.max(0, match.index - offset), end });
  }
  return spans;
}

function continuationSpan(shape: string, text: string, kind: CredentialKind, offset: number): Span[] {
  const pattern = CONTINUATIONS.get(kind)!;
  pattern.lastIndex = 0;
  const match = pattern.exec(shape + text);
  const end = (match?.[0].length ?? 0) - shape.length - offset;
  return end > 0 ? [{ start: 0, end }] : [];
}

function mergeSpans(left: Span[], right: Span[]): Span[] {
  if (!left.length) return right;
  if (!right.length) return left;
  const spans: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const a = left[i];
    const b = right[j];
    const span = a && (!b || a.start <= b.start) ? left[i++]! : right[j++]!;
    const previous = spans.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else spans.push(span);
  }
  return spans;
}

export function redactTextSegments(
  segments: readonly string[],
  fullText?: string,
  context?: RedactionContext,
): string[] {
  if (segments.length === 0) return [];
  const joined = segments.join('');
  if (!joined) return [...segments];
  // Context precedes the retained aggregate. A timeline can start further to its right.
  const retained = fullText?.endsWith(joined) ? fullText : joined;
  const alignedContext = fullText === undefined || fullText === retained ? context : undefined;
  const source = (alignedContext?.suffix ?? '') + retained;
  const skipped = retained.length - joined.length;
  let spans: Span[] = [];
  for (const kind of CREDENTIAL_KINDS) {
    const pattern = PATTERNS[kind];
    spans = mergeSpans(spans, maskSpans(source, pattern, source.length - joined.length));
    for (const shape of alignedContext?.shapes.get(kind) ?? []) {
      spans = mergeSpans(spans, continuationSpan(shape, retained, kind, skipped));
    }
  }
  if (!spans.length) return [...segments];
  let offset = 0;
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
        text += `${joined.slice(cursor, start)}[REDACTED]`;
      }
      coveredUntil = Math.max(coveredUntil, span.end);
      cursor = Math.max(cursor, coveredUntil);
    }
    if (cursor < end) text += joined.slice(cursor, end);
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
