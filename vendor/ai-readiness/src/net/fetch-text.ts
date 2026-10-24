import { isIP } from 'node:net';
import { pipeline, Transform, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Agent, request, type Dispatcher } from 'undici';
import type { AddressRefusal } from './address';
import {
  createNetworkGuard,
  guardedConnector,
  NetworkGuardError,
  type HostResolver,
  type NetworkGuard,
} from './guard';

/**
 * `fetchText`: the one way this library reads a file from a site. The library is run by
 * strangers against URLs they type, and a site's answer (a redirect, a sitemap entry, an
 * llms.txt link) can point anywhere, so every request is held to these rules:
 *
 * - The URL is parsed by the WHATWG parser. Only `http` and `https`, only ports 80 and 443, no
 *   user name or password, a host name (an IP-literal host is refused, in every spelling the
 *   parser accepts), at most 253 characters.
 * - The connection goes through the network guard: the name is resolved once, every address
 *   must be public (private, loopback, link-local, cloud metadata and the other special ranges
 *   are refused), and the socket is opened to the address that was checked, so a DNS answer
 *   that changes between check and connect cannot slip through.
 * - At most 3 redirects, each checked again as a new request; the final URL and host are
 *   reported.
 * - 5 seconds to connect, 10 seconds a request (network time of the whole redirect chain), and
 *   the caller's overall budget through `signal`.
 * - A size cap per kind of file, counted after decompression; a longer body is cut there and
 *   reported as cut.
 * - GET only, no cookies, no credentials, no proxy from the environment; the body is read as
 *   UTF-8 text.
 * - Politeness per host: one request a second, `Crawl-delay` up to 10 seconds, and no further
 *   request to a host that answered 429 or 503.
 *
 * Nothing a site does makes it throw: every failure is an `outcome` on the result.
 */

/** Who the library says it is. */
export const AI_READINESS_USER_AGENT =
  'Mozilla/5.0 (compatible; QueryRev-AIReadiness/1.0; +https://queryrev.com/bot)';

/** The kinds of file the library reads, each with its own size cap. */
export type FetchKind = 'robots' | 'llms' | 'page' | 'sitemap';

/** Size caps in bytes, counted after decompression. */
export const FETCH_LIMITS: Readonly<Record<FetchKind, number>> = Object.freeze({
  robots: 500 * 1024,
  llms: 1024 * 1024,
  page: 2 * 1024 * 1024,
  sitemap: 5 * 1024 * 1024,
});

/** Redirects followed after the first request. */
export const MAX_REDIRECTS = 3;
/** Longest host name accepted, in characters (as the parser writes it, punycode for IDNs). */
export const MAX_HOST_LENGTH = 253;
/** Time allowed to open a connection (TCP, and TLS for https). */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Time allowed for one `fetchText` call, redirects included; waits for politeness excluded. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Overall budgets a caller passes through `signal`: a site check, and llms.txt generation. */
export const CHECK_BUDGET_MS = 30_000;
export const GENERATE_BUDGET_MS = 120_000;
/** Politeness: the smallest gap between two request starts to one host. */
export const HOST_INTERVAL_MS = 1_000;
/** `Crawl-delay` is honoured up to this many seconds. */
export const MAX_CRAWL_DELAY_SECONDS = 10;

/**
 * Compressed bytes read before decoding stops, above the decoded cap. Compression never makes
 * real text much larger, so this only bounds a stream that would never decode to the cap.
 */
const WIRE_SLACK_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT: Readonly<Record<FetchKind, string>> = Object.freeze({
  robots: 'text/plain, */*;q=0.5',
  llms: 'text/markdown, text/plain;q=0.9, */*;q=0.5',
  page: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5',
  sitemap: 'application/xml, text/xml;q=0.9, */*;q=0.5',
});

/** Response headers passed on. Everything else, cookies first, is dropped. */
export const KEPT_HEADERS = Object.freeze([
  'content-type',
  'content-language',
  'last-modified',
  'etag',
  'x-robots-tag',
  'retry-after',
] as const);
export type KeptHeader = (typeof KEPT_HEADERS)[number];

/** Why a URL was refused before any connection. */
export type UrlRefusal =
  'invalid_url' | 'scheme' | 'credentials' | 'ip_literal' | 'host_too_long' | 'port';

export type TextFetchOutcome =
  /** An HTTP answer that is not a followed redirect (any status). */
  | 'response'
  /** The URL (or a redirect target) broke a URL rule; `refusal` says which. */
  | 'refused_url'
  /** The host resolved to an address that is not allowed; `refusal` says why. */
  | 'refused_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'redirect_loop'
  /** A redirect without a usable `Location`. */
  | 'invalid_redirect'
  /** A redirect the caller's `redirectAllowed` refused; its target was not contacted. */
  | 'redirect_refused'
  /** The connection or the request ran out of its time. */
  | 'timeout'
  /** The caller's overall budget (`signal`) ran out. */
  | 'budget_exceeded'
  /** The host answered 429 or 503 earlier; no further request is sent to it. */
  | 'host_stopped'
  | 'network_error';

export interface RedirectHop {
  readonly url: string;
  readonly status: number;
  /** Where it pointed, resolved against `url`; null when `Location` was unusable. */
  readonly location: string | null;
}

export interface TextFetchResult {
  readonly outcome: TextFetchOutcome;
  readonly refusal: UrlRefusal | AddressRefusal | null;
  readonly requestedUrl: string;
  /** The last URL requested or refused (the requested URL when there were no redirects). */
  readonly finalUrl: string;
  /** Host of `finalUrl`; empty when the URL did not parse. */
  readonly finalHost: string;
  readonly redirects: readonly RedirectHop[];
  /** Status of the last answer; null when none arrived. */
  readonly status: number | null;
  /** Media type without parameters, lower case; null when absent. */
  readonly contentType: string | null;
  readonly headers: Readonly<Partial<Record<KeptHeader, readonly string[]>>>;
  /** The body as UTF-8 text, up to the cap; null when no body was read or it did not decode. */
  readonly text: string | null;
  /**
   * The same decoded bytes, for a file that is not text (a gzip sitemap served as a file, not as
   * a content encoding); null when no body was read.
   */
  readonly rawBody: Uint8Array | null;
  /** Decoded bytes kept. */
  readonly bytes: number;
  /** The cap that applied. */
  readonly limitBytes: number;
  /** The body went over the cap and was cut there. */
  readonly truncated: boolean;
  /** The content encoding was unknown or the compressed stream was corrupt. */
  readonly decodeFailed: boolean;
  /** Requests attempted, a connection the guard refused included. */
  readonly requests: number;
  /** Network milliseconds of the whole call, waits for politeness excluded. */
  readonly elapsedMs: number;
}

export interface FetchTextOptions {
  readonly kind: FetchKind;
  /** A lower cap than the kind's (for example to read only the start of a page). */
  readonly maxBytes?: number;
  /** The caller's overall budget. When it aborts, the call ends as `budget_exceeded`. */
  readonly signal?: AbortSignal;
  /**
   * Where a redirect may lead, asked before each further hop (after the URL rules and before
   * the guard). A hop it refuses ends the call as `redirect_refused`, and its target is never
   * contacted. The guard still checks every hop it allows.
   */
  readonly redirectAllowed?: (target: URL) => boolean;
}

export interface TextFetcher {
  fetchText(url: string, options: FetchTextOptions): Promise<TextFetchResult>;
  /** Applies robots.txt `Crawl-delay` (seconds) for a host, capped at 10. Only ever slows. */
  setCrawlDelay(host: string, seconds: number | null): void;
  /** Whether a host answered 429 or 503 and gets no further request. */
  isStopped(host: string): boolean;
  close(): Promise<void>;
}

export interface TextFetcherOptions {
  /** The resolver; the operating system's by default. Every answer is still checked. */
  readonly resolver?: HostResolver;
}

/** Settings only the testing entry point may change (fixture port, short timeouts). */
export interface TextFetcherConfig {
  readonly guard: NetworkGuard;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly hostIntervalMs?: number;
  /** Extra trusted CA certificate; never set in production. */
  readonly testCa?: string;
}

/**
 * The production fetcher, with the strict guard: public addresses only. There is no option that
 * loosens it; the private-network opt-in for a command-line user lives in the `./cli` entry
 * point only.
 *
 * Use one fetcher per check (or per generation run) and call `close()` after: the fetcher
 * holds that run's connections and its politeness state.
 */
export function createTextFetcher(options: TextFetcherOptions = {}): TextFetcher {
  // Only the resolver is read; any other field a caller passes (from JavaScript) is ignored.
  const resolver = options.resolver;
  return buildTextFetcher({
    guard: createNetworkGuard(resolver === undefined ? {} : { resolver }),
  });
}

/** A host as politeness and reports key it: lower case, without one trailing dot. */
export function hostKey(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** The URL rules applied before the guard. Exported for its tests only. */
export function checkTextUrl(input: string | URL): { url: URL } | { refusal: UrlRefusal } {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return { refusal: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { refusal: 'scheme' };
  if (url.username !== '' || url.password !== '') return { refusal: 'credentials' };
  const host = stripBrackets(url.hostname);
  if (host === '') return { refusal: 'invalid_url' };
  if (isIP(host) !== 0) return { refusal: 'ip_literal' };
  if (url.hostname.length > MAX_HOST_LENGTH) return { refusal: 'host_too_long' };
  return { url };
}

function headerValues(headers: Dispatcher.ResponseData['headers'], name: string): string[] {
  const value = headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function keptHeaders(
  headers: Dispatcher.ResponseData['headers'],
): Partial<Record<KeptHeader, readonly string[]>> {
  const kept: Partial<Record<KeptHeader, readonly string[]>> = {};
  for (const name of KEPT_HEADERS) {
    const values = headerValues(headers, name);
    if (values.length > 0) kept[name] = Object.freeze(values);
  }
  return kept;
}

function mediaType(headers: Dispatcher.ResponseData['headers']): string | null {
  const value = headerValues(headers, 'content-type')[0];
  if (value === undefined) return null;
  const type = value.split(';')[0]!.trim().toLowerCase();
  return type === '' ? null : type;
}

function decoderFor(encoding: string): NodeJS.ReadWriteStream | null | 'unknown' {
  switch (encoding) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return 'unknown';
  }
}

function discard(body: Readable): void {
  body.on('error', () => {});
  body.destroy();
}

function isZlibError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === 'string' &&
    (error as NodeJS.ErrnoException).code!.startsWith('Z_')
  );
}

interface BodyRead {
  readonly body: Buffer | null;
  readonly truncated: boolean;
  readonly decodeFailed: boolean;
}

/**
 * Reads a body up to `limit` decoded bytes. Decoding stops at the cap, so a small compressed
 * bomb cannot grow past it, and the compressed stream itself is bounded too.
 */
async function readLimited(
  body: Readable,
  encodingHeader: string,
  limit: number,
): Promise<BodyRead> {
  const encodings = encodingHeader
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const decoder = encodings.length > 1 ? 'unknown' : decoderFor(encodings[0] ?? '');
  if (decoder === 'unknown') {
    discard(body);
    return { body: null, truncated: false, decodeFailed: true };
  }
  let wireTruncated = false;
  let source: AsyncIterable<Buffer>;
  if (decoder === null) {
    source = body as AsyncIterable<Buffer>;
  } else {
    let wireBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        wireBytes += chunk.length;
        if (wireBytes > limit + WIRE_SLACK_BYTES) {
          wireTruncated = true;
          callback(new Error('wire_limit'));
          return;
        }
        callback(null, chunk);
      },
    });
    pipeline(body, counter, decoder, () => {});
    source = decoder as unknown as AsyncIterable<Buffer>;
  }
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  let decodeFailed = false;
  try {
    for await (const chunk of source) {
      const room = limit - kept;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        kept += room;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      kept += chunk.length;
    }
  } catch (error) {
    if (wireTruncated) truncated = true;
    else if (decoder !== null && isZlibError(error)) decodeFailed = true;
    else throw error;
  } finally {
    discard(body);
    if (decoder !== null) (decoder as unknown as Readable).destroy();
  }
  if (wireTruncated) truncated = true;
  if (decodeFailed) return { body: null, truncated: false, decodeFailed: true };
  return { body: Buffer.concat(chunks, kept), truncated, decodeFailed: false };
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 5) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
]);

function classifyError(
  error: unknown,
  budget: AbortSignal | undefined,
): { outcome: TextFetchOutcome; refusal: AddressRefusal | UrlRefusal | null } {
  for (const item of errorChain(error)) {
    if (!(item instanceof NetworkGuardError)) continue;
    if (item.code === 'refused_address')
      return { outcome: 'refused_address', refusal: item.reason };
    if (item.code === 'refused_port') return { outcome: 'refused_url', refusal: 'port' };
    if (item.code === 'refused_scheme') return { outcome: 'refused_url', refusal: 'scheme' };
    return { outcome: 'dns_failed', refusal: null };
  }
  if (budget?.aborted === true) return { outcome: 'budget_exceeded', refusal: null };
  for (const item of errorChain(error)) {
    if (!(item instanceof Error)) continue;
    const code = (item as NodeJS.ErrnoException).code;
    if (item.name === 'TimeoutError' || item.name === 'AbortError') {
      return { outcome: 'timeout', refusal: null };
    }
    if (code !== undefined && TIMEOUT_CODES.has(code)) return { outcome: 'timeout', refusal: null };
  }
  return { outcome: 'network_error', refusal: null };
}

/** Waits `ms`, or rejects when the signal aborts first. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0)
    return signal?.aborted === true ? Promise.reject(new Error('aborted')) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Hosts whose politeness state is kept; past it the oldest entry is dropped. */
export const MAX_TRACKED_HOSTS = 1_000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  // Re-inserted so the map's order is the order of last use, and the first entry the oldest.
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_HOSTS) map.delete(map.keys().next().value as K);
}

/**
 * One request a second per host, `Crawl-delay` up to 10 s, stop after 429 or 503. The state is
 * bounded: start slots already in the past are dropped, and each table keeps at most
 * MAX_TRACKED_HOSTS hosts (a check reads a handful; only a site that redirects to thousands of
 * hosts reaches the bound). Exported for its tests only.
 */
export class HostPacing {
  private readonly nextAt = new Map<string, number>();
  private readonly interval = new Map<string, number>();
  private readonly stopped = new Map<string, true>();
  constructor(
    private readonly baseIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Entries held per table, for tests of the bound. */
  get sizes(): { readonly nextAt: number; readonly interval: number; readonly stopped: number } {
    return { nextAt: this.nextAt.size, interval: this.interval.size, stopped: this.stopped.size };
  }

  intervalFor(host: string): number {
    return this.interval.get(hostKey(host)) ?? this.baseIntervalMs;
  }

  setCrawlDelay(host: string, seconds: number | null): void {
    if (seconds === null || !Number.isFinite(seconds) || !(seconds > 0)) return;
    const key = hostKey(host);
    const delayMs = Math.min(seconds, MAX_CRAWL_DELAY_SECONDS) * 1000;
    const current = this.intervalFor(key);
    if (delayMs <= current) return;
    remember(this.interval, key, delayMs);
    const next = this.nextAt.get(key);
    if (next !== undefined) this.nextAt.set(key, next + delayMs - current);
  }

  stop(host: string): void {
    remember(this.stopped, hostKey(host), true);
  }

  isStopped(host: string): boolean {
    return this.stopped.has(hostKey(host));
  }

  /** Reserves the next start slot for a host synchronously, then waits for it. */
  async acquire(host: string, signal: AbortSignal | undefined): Promise<void> {
    const key = hostKey(host);
    const now = this.now();
    for (const [other, at] of this.nextAt) if (at <= now) this.nextAt.delete(other);
    const at = Math.max(now, this.nextAt.get(key) ?? 0);
    remember(this.nextAt, key, at + this.intervalFor(key));
    await wait(at - now, signal);
  }
}

/** The fetcher with the given guard and timings. Production reaches it only with the defaults. */
export function buildTextFetcher(config: TextFetcherConfig): TextFetcher {
  const connectTimeoutMs = config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const requestTimeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const guard = config.guard;
  const pacing = new HostPacing(config.hostIntervalMs ?? HOST_INTERVAL_MS);
  // The agent follows no redirect and uses no proxy from the environment: every connection goes
  // through the guarded connector, to the address the guard checked.
  const agent = new Agent({
    connect: guardedConnector(guard, connectTimeoutMs, config.testCa),
    connections: 1,
    pipelining: 1,
    headersTimeout: requestTimeoutMs,
    bodyTimeout: requestTimeoutMs,
  });

  async function fetchText(start: string, options: FetchTextOptions): Promise<TextFetchResult> {
    // A caller error, not a site's: an unknown kind has no cap, so it is refused outright.
    if (!Object.hasOwn(FETCH_LIMITS, options.kind)) {
      throw new TypeError('fetchText: unknown kind');
    }
    const cap = FETCH_LIMITS[options.kind];
    // A lower cap is honoured only when it is a real number of bytes; NaN, Infinity, a negative
    // number or a non-number is ignored, so the kind's cap always applies.
    const asked = options.maxBytes;
    const limitBytes =
      typeof asked === 'number' && Number.isFinite(asked) && asked >= 0
        ? Math.min(Math.floor(asked), cap)
        : cap;
    const budget = options.signal;
    const redirects: RedirectHop[] = [];
    const seen = new Set<string>();
    let requests = 0;
    let spentMs = 0;
    let currentHref = start;

    const finish = (
      outcome: TextFetchOutcome,
      refusal: UrlRefusal | AddressRefusal | null,
      extra: Partial<TextFetchResult> = {},
    ): TextFetchResult => {
      let finalHost = '';
      try {
        finalHost = hostKey(new URL(currentHref).hostname);
      } catch {
        finalHost = '';
      }
      return Object.freeze({
        outcome,
        refusal,
        requestedUrl: start,
        finalUrl: currentHref,
        finalHost,
        redirects: Object.freeze([...redirects]),
        status: null,
        contentType: null,
        headers: Object.freeze({}),
        text: null,
        rawBody: null,
        bytes: 0,
        limitBytes,
        truncated: false,
        decodeFailed: false,
        requests,
        elapsedMs: spentMs,
        ...extra,
      });
    };

    let current: URL;
    for (;;) {
      const checked = checkTextUrl(currentHref);
      if ('refusal' in checked) return finish('refused_url', checked.refusal);
      current = checked.url;
      currentHref = current.href;
      try {
        guard.checkUrl(current);
      } catch (error) {
        const { outcome, refusal } = classifyError(error, budget);
        return finish(outcome, refusal);
      }
      seen.add(current.href);
      if (pacing.isStopped(current.hostname)) return finish('host_stopped', null);
      try {
        await pacing.acquire(current.hostname, budget);
      } catch {
        return finish('budget_exceeded', null);
      }
      const remainingMs = requestTimeoutMs - spentMs;
      if (remainingMs <= 0) return finish('timeout', null);
      const timeout = AbortSignal.timeout(Math.ceil(remainingMs));
      const signal = budget === undefined ? timeout : AbortSignal.any([budget, timeout]);
      const started = performance.now();
      requests += 1;
      let response: Dispatcher.ResponseData;
      try {
        response = await request(current, {
          dispatcher: agent,
          method: 'GET',
          headers: {
            'user-agent': AI_READINESS_USER_AGENT,
            accept: ACCEPT[options.kind],
            'accept-encoding': 'gzip, deflate, br',
          },
          signal,
        });
      } catch (error) {
        spentMs += performance.now() - started;
        const { outcome, refusal } = classifyError(error, budget);
        return finish(outcome, refusal);
      }
      const status = response.statusCode;
      if (status === 429 || status === 503) pacing.stop(current.hostname);
      const location = headerValues(response.headers, 'location')[0];
      if (REDIRECT_STATUSES.has(status) && location !== undefined) {
        await response.body.dump({ limit: 64 * 1024 }).catch(() => {});
        spentMs += performance.now() - started;
        let target: URL | null;
        try {
          target = new URL(location, current);
        } catch {
          target = null;
        }
        redirects.push(
          Object.freeze({ url: current.href, status, location: target?.href ?? null }),
        );
        if (target === null) return finish('invalid_redirect', null, { status });
        if (seen.has(target.href)) return finish('redirect_loop', null, { status });
        if (redirects.length > MAX_REDIRECTS) return finish('too_many_redirects', null, { status });
        // The caller's own rule for where a redirect may lead (for example the same site only),
        // asked before the next hop is requested, so a refused target is never contacted.
        if (options.redirectAllowed !== undefined && !options.redirectAllowed(target)) {
          return finish('redirect_refused', null, { status });
        }
        currentHref = target.href;
        continue;
      }
      const contentType = mediaType(response.headers);
      let read: BodyRead;
      try {
        const encoding = headerValues(response.headers, 'content-encoding').join(',');
        read = await readLimited(response.body, encoding, limitBytes);
      } catch (error) {
        discard(response.body);
        spentMs += performance.now() - started;
        const { outcome, refusal } = classifyError(error, budget);
        return finish(outcome, refusal, { status, contentType });
      }
      spentMs += performance.now() - started;
      return finish('response', null, {
        status,
        contentType,
        headers: Object.freeze(keptHeaders(response.headers)),
        // Non-streaming decode of a cut body would end in a replacement character for a
        // character split at the cap; stream mode holds the incomplete tail back instead.
        text:
          read.body === null
            ? null
            : new TextDecoder('utf-8').decode(read.body, { stream: read.truncated }),
        // A copy, so it never shares memory with Node's buffer pool.
        rawBody: read.body === null ? null : new Uint8Array(read.body),
        bytes: read.body?.length ?? 0,
        truncated: read.truncated,
        decodeFailed: read.decodeFailed,
      });
    }
  }

  return Object.freeze({
    fetchText,
    setCrawlDelay: (host: string, seconds: number | null) => pacing.setCrawlDelay(host, seconds),
    isStopped: (host: string) => pacing.isStopped(host),
    close: () => agent.close(),
  });
}
