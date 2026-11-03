export type MetaArtifact = 'metadata' | 'captions' | 'thumbnail'

export type MetaErrorKind =
  | 'unavailable'
  | 'rate_limited'
  | 'circuit_open'
  | 'auth'
  | 'quota'
  | 'not_found'
  | 'login_required'
  | 'network'
  | 'timeout'
  | 'parse'
  | 'provider'

declare const metaErrorBrand: unique symbol

/** An error whose message has passed through {@link sanitize}. */
export type MetaError = {
  readonly artifact: MetaArtifact
  readonly kind: MetaErrorKind
  readonly message: string
  readonly retryable: boolean
  readonly [metaErrorBrand]: true
}

const DEFAULT_RETRYABLE = new Set<MetaErrorKind>(['rate_limited', 'circuit_open', 'network', 'timeout'])

function stringify(raw: unknown, seen = new Set<unknown>()): string {
  if (raw instanceof Error) {
    if (seen.has(raw)) return `${raw.name}: ${raw.message}`
    seen.add(raw)
    const cause = (raw as Error & {cause?: unknown}).cause
    const text = `${raw.name}: ${raw.message}`
    return cause === undefined ? text : `${text}\nCaused by: ${stringify(cause, seen)}`
  }
  if (typeof raw === 'string') return raw
  if (raw === null || raw === undefined) return String(raw)
  if (typeof raw === 'object') {
    try {
      const json = JSON.stringify(raw)
      if (json !== undefined) return json
    } catch {
      // Fall through to a safe string conversion for cyclic or hostile objects.
    }
  }
  try {
    return String(raw)
  } catch {
    return '[unprintable error]'
  }
}

/** Redact secrets and API-key query parameters from text before it is exposed. */
export function sanitize(text: string, secrets?: string[]): string {
  const candidates = secrets ?? (process.env.YOUTUBE_API_KEY ? [process.env.YOUTUBE_API_KEY] : [])
  const forms = new Set<string>()
  for (const secret of candidates) {
    if (!secret) continue
    forms.add(secret)
    forms.add(encodeURIComponent(secret))
    forms.add(new URLSearchParams([['secret', secret]]).toString().slice('secret='.length))
  }

  let sanitized = text
  for (const secret of [...forms].sort((a, b) => b.length - a.length)) {
    if (secret) sanitized = sanitized.split(secret).join('REDACTED')
  }
  return sanitized.replace(/(^|[?&\s"'(])key=[^&\s"')]*/gi, '$1key=REDACTED')
}

/** The sole constructor for MetaError; raw provider messages are always sanitized. */
export function metaError(
  artifact: MetaArtifact,
  kind: MetaErrorKind,
  rawMessage: unknown,
  opts?: {retryable?: boolean},
): MetaError {
  return {
    artifact,
    kind,
    message: sanitize(stringify(rawMessage)),
    retryable: opts?.retryable ?? DEFAULT_RETRYABLE.has(kind),
  } as MetaError
}

export type Result<T> =
  | {ok: true; value: T; warnings: MetaError[]}
  | {ok: false; error: MetaError; warnings: MetaError[]}

export function ok<T>(value: T, warnings: MetaError[] = []): Result<T> {
  return {ok: true, value, warnings}
}

export function fail<T = never>(error: MetaError, warnings: MetaError[] = []): Result<T> {
  return {ok: false, error, warnings}
}
