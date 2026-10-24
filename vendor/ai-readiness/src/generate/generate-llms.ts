/**
 * `generateLlmsTxt`: reads a site's own files and builds the skeleton of an llms.txt from them.
 * No model is involved: each page's title and meta description are used as the page wrote them.
 *
 * Requests, each only where robots.txt lets this reader in:
 *
 * 1. `/robots.txt`
 * 2. the home page (the site's name and summary come from it)
 * 3. the `Sitemap:` files robots.txt lists, on the same site, at most 5 (a sitemap index counts
 *    each file it leads to), 5 MiB each; when there are none, the links on the home page
 * 4. up to `maxPages` of the pages found, 256 KiB of each
 *
 * Only pages on the same site are listed, and pages that say `noindex`, answer anything but a
 * 200 HTML document, or redirect to another site are left out and counted in `skipped`.
 */
import { gunzipSync } from 'node:zlib';
import { registrableDomain as defaultRegistrableDomain } from '../facts/domain';
import { createOriginRobots } from '../facts/origin-robots';
import { xRobotsNoindex } from '../facts/home-page';
import {
  checkTextUrl,
  createTextFetcher,
  FETCH_LIMITS,
  GENERATE_BUDGET_MS,
  type TextFetcher,
} from '../net/fetch-text';
import type { RobotsTxt } from '../robots';
import {
  attributes,
  PAGE_SCAN_MAX_CHARS,
  pageMeta,
  renderLlmsTxt,
  sitemapLocations,
  stripUnsafeCharacters,
  type LlmsPage,
  type LlmsSite,
} from './index';

/** Pages listed when the caller does not say. */
export const GENERATE_DEFAULT_PAGES = 30;
/** The most pages one run lists. */
export const GENERATE_MAX_PAGES = 100;
/** Sitemap files read in one run. */
export const GENERATE_MAX_SITEMAPS = 5;
/** Bytes of each page that are read: the part `pageMeta` looks at. */
export const GENERATE_PAGE_BYTES = PAGE_SCAN_MAX_CHARS;
/** Addresses taken from the home page when the site lists no sitemap. */
const HOME_LINKS_MAX = 500;
/** Pages requested per page listed, at most: skipped pages cost requests too. */
const ATTEMPT_FACTOR = 2;

export type SkippedReason =
  'robots' | 'noindex' | 'not_html' | 'status' | 'off_site' | 'unreachable' | 'duplicate';

export interface SkippedPage {
  readonly url: string;
  readonly reason: SkippedReason;
}

export type GenerateOutcome =
  /** A file was built. */
  | 'generated'
  /** The address cannot be checked (not a web site name). */
  | 'refused'
  /** robots.txt could not be read, so nothing else was requested. */
  | 'robots_unreadable'
  /** No page could be read: robots.txt keeps this reader out, or nothing answered. */
  | 'nothing_found';

export interface GeneratedLlms {
  readonly schemaVersion: 1;
  readonly outcome: GenerateOutcome;
  readonly origin: string;
  readonly host: string;
  /** The file; null unless the outcome is `generated`. */
  readonly text: string | null;
  readonly site: LlmsSite | null;
  readonly pages: readonly LlmsPage[];
  /** Where the page addresses came from. */
  readonly source: 'sitemap' | 'home_links' | 'none';
  readonly skipped: readonly SkippedPage[];
  /** The run ran out of time and listed what it had. */
  readonly budgetReached: boolean;
  /** One plain sentence about anything the reader should know. */
  readonly notes: readonly string[];
}

export interface GenerateOptions {
  /** Pages to list: 30 by default, at most 100. */
  readonly maxPages?: number;
  readonly fetcher?: TextFetcher;
  readonly signal?: AbortSignal;
  readonly registrableDomain?: (host: string) => string;
}

const ASSET_EXTENSION =
  /\.(?:jpe?g|png|gif|svg|webp|avif|ico|pdf|zip|gz|xml|json|css|m?js|txt|mp[34]|webm|woff2?|ttf|otf|docx?|xlsx?|pptx?|csv|rss|atom)$/i;

/** The addresses of the `<a href>` links of a page, resolved against `base`; at most `max`. */
export function homeLinks(html: string, base: string, max: number = HOME_LINKS_MAX): string[] {
  const text = html.length > PAGE_SCAN_MAX_CHARS ? html.slice(0, PAGE_SCAN_MAX_CHARS) : html;
  const out: string[] = [];
  const seen = new Set<string>();
  let at = 0;
  while (out.length < max) {
    const open = text.indexOf('<a', at);
    if (open === -1) break;
    const next = text[open + 2];
    if (next === undefined || !(next === ' ' || next === '\n' || next === '\t' || next === '\r')) {
      at = open + 2;
      continue;
    }
    const end = text.indexOf('>', open + 2);
    if (end === -1) break;
    at = end + 1;
    const href = attributes(text.slice(open + 2, end)).get('href');
    if (href === undefined || href.trim() === '') continue;
    let url: URL;
    try {
      url = new URL(stripUnsafeCharacters(href.trim()), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    if (!seen.has(url.href)) {
      seen.add(url.href);
      out.push(url.href);
    }
  }
  return out;
}

function sitemapText(rawBody: Uint8Array | null, text: string | null): string | null {
  if (rawBody !== null && rawBody.length > 2 && rawBody[0] === 0x1f && rawBody[1] === 0x8b) {
    try {
      const inflated = gunzipSync(rawBody, { maxOutputLength: FETCH_LIMITS.sitemap });
      return inflated.toString('utf8');
    } catch {
      return null;
    }
  }
  return text;
}

function clampPages(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return GENERATE_DEFAULT_PAGES;
  return Math.min(GENERATE_MAX_PAGES, Math.max(1, Math.floor(value)));
}

function empty(
  outcome: GenerateOutcome,
  origin: string,
  host: string,
  notes: readonly string[],
): GeneratedLlms {
  return Object.freeze({
    schemaVersion: 1,
    outcome,
    origin,
    host,
    text: null,
    site: null,
    pages: Object.freeze([]),
    source: 'none',
    skipped: Object.freeze([]),
    budgetReached: false,
    notes: Object.freeze([...notes]),
  });
}

export async function generateLlmsTxt(
  input: string,
  options: GenerateOptions = {},
): Promise<GeneratedLlms> {
  const registrable = options.registrableDomain ?? defaultRegistrableDomain;
  const typed = input.trim();
  const checked = checkTextUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  if ('refusal' in checked) {
    return empty('refused', '', '', [
      'The address cannot be checked: it must be a web site name or an http(s) address.',
    ]);
  }
  const origin = checked.url.origin;
  const host = checked.url.hostname;
  const siteDomain = registrable(host);
  const maxPages = clampPages(options.maxPages);

  const owned = options.fetcher === undefined;
  const fetcher = options.fetcher ?? createTextFetcher();
  const budget = AbortSignal.timeout(GENERATE_BUDGET_MS);
  const signal = options.signal === undefined ? budget : AbortSignal.any([options.signal, budget]);
  const sameSite = (target: URL): boolean => registrable(target.hostname) === siteDomain;
  const notes: string[] = [];
  const skipped: SkippedPage[] = [];

  try {
    // Each origin is asked on its own robots.txt, read once: a sitemap entry on a subdomain or
    // on the other scheme is not covered by the file of the site's own origin.
    const origins = createOriginRobots({ fetcher, signal, redirectAllowed: sameSite });
    const robots = await origins.robotsOf(origin);
    if (robots === null) {
      return empty('robots_unreadable', origin, host, [
        'robots.txt could not be read, so nothing else was requested.',
      ]);
    }
    const allowed = async (url: string): Promise<boolean> =>
      (await origins.check(url)) === 'allowed';

    // The home page: the site's name and summary, its own entry, and the fallback list of links.
    let site: LlmsSite = { name: host, summary: null };
    const pages: LlmsPage[] = [];
    const listed = new Set<string>();
    let homeHtml: string | null = null;
    if (await allowed(`${origin}/`)) {
      const home = await fetcher.fetchText(`${origin}/`, {
        kind: 'page',
        maxBytes: GENERATE_PAGE_BYTES,
        signal,
        redirectAllowed: sameSite,
      });
      const page = readPage(home, sameSite);
      if (page.kind === 'page') {
        homeHtml = page.html;
        const meta = pageMeta(page.html);
        site = { name: meta.title ?? meta.h1 ?? host, summary: meta.description };
        if (!meta.noindex && !page.noindex) {
          pages.push({
            url: page.finalUrl,
            title: meta.title ?? meta.h1 ?? host,
            description: meta.description,
          });
          listed.add(page.finalUrl);
        }
      } else {
        notes.push('The home page could not be read, so the site is named by its host.');
      }
    } else {
      notes.push('robots.txt keeps this reader from the home page, so it was not requested.');
    }

    // The addresses to read.
    let source: GeneratedLlms['source'] = 'none';
    let candidates: string[] = [];
    const fromSitemaps = await sitemapAddresses(fetcher, robots, allowed, sameSite, signal, notes);
    if (fromSitemaps.length > 0) {
      source = 'sitemap';
      candidates = fromSitemaps;
    } else if (homeHtml !== null) {
      source = 'home_links';
      candidates = homeLinks(homeHtml, `${origin}/`);
      notes.push('No usable sitemap was found, so the links on the home page were used.');
    }
    candidates = candidates.filter((url) => {
      try {
        const parsed = new URL(url);
        return (
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          sameSite(parsed) &&
          !ASSET_EXTENSION.test(parsed.pathname)
        );
      } catch {
        return false;
      }
    });

    let attempts = 0;
    const attemptLimit = Math.min(200, maxPages * ATTEMPT_FACTOR);
    let budgetReached = false;
    for (const candidate of candidates) {
      if (pages.length >= maxPages || attempts >= attemptLimit) break;
      if (signal.aborted) {
        budgetReached = true;
        break;
      }
      if (listed.has(candidate)) {
        continue;
      }
      if (!(await allowed(candidate))) {
        skipped.push({ url: candidate, reason: 'robots' });
        continue;
      }
      attempts += 1;
      const result = await fetcher.fetchText(candidate, {
        kind: 'page',
        maxBytes: GENERATE_PAGE_BYTES,
        signal,
        redirectAllowed: sameSite,
      });
      if (result.outcome === 'budget_exceeded') {
        budgetReached = true;
        break;
      }
      const page = readPage(result, sameSite);
      if (page.kind !== 'page') {
        skipped.push({ url: candidate, reason: page.kind });
        continue;
      }
      if (listed.has(page.finalUrl)) {
        skipped.push({ url: candidate, reason: 'duplicate' });
        continue;
      }
      const meta = pageMeta(page.html);
      if (meta.noindex || page.noindex) {
        skipped.push({ url: candidate, reason: 'noindex' });
        continue;
      }
      listed.add(page.finalUrl);
      pages.push({
        url: page.finalUrl,
        title: meta.title ?? meta.h1 ?? '',
        description: meta.description,
      });
    }
    if (budgetReached) {
      notes.push(
        'The time limit of 120 seconds was reached; the file lists the pages read so far.',
      );
    }
    if (pages.length === 0) {
      return Object.freeze({
        ...empty('nothing_found', origin, host, [
          ...notes,
          'No page could be read from this site.',
        ]),
        skipped: Object.freeze(skipped),
        budgetReached,
      });
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      outcome: 'generated' as const,
      origin,
      host,
      text: renderLlmsTxt(site, pages),
      site,
      pages: Object.freeze(pages),
      source,
      skipped: Object.freeze(skipped),
      budgetReached,
      notes: Object.freeze(notes),
    });
  } finally {
    if (owned) await fetcher.close();
  }
}

type PageRead =
  | { kind: 'page'; html: string; finalUrl: string; noindex: boolean }
  | { kind: 'not_html' | 'status' | 'off_site' | 'unreachable' };

function readPage(
  result: Awaited<ReturnType<TextFetcher['fetchText']>>,
  sameSite: (target: URL) => boolean,
): PageRead {
  if (result.outcome === 'redirect_refused') return { kind: 'off_site' };
  if (result.outcome !== 'response' || result.status === null) return { kind: 'unreachable' };
  if (result.status !== 200) return { kind: 'status' };
  if (
    result.text === null ||
    result.contentType === null ||
    !(result.contentType === 'text/html' || result.contentType === 'application/xhtml+xml')
  ) {
    return { kind: 'not_html' };
  }
  let final: URL;
  try {
    final = new URL(result.finalUrl);
  } catch {
    return { kind: 'unreachable' };
  }
  if (!sameSite(final)) return { kind: 'off_site' };
  final.hash = '';
  return {
    kind: 'page',
    html: result.text,
    finalUrl: final.href,
    noindex: xRobotsNoindex(result.headers['x-robots-tag']),
  };
}

/** The page addresses of the site's sitemaps; empty when there are none to read. */
async function sitemapAddresses(
  fetcher: TextFetcher,
  robots: RobotsTxt,
  allowed: (url: string) => Promise<boolean>,
  sameSite: (target: URL) => boolean,
  signal: AbortSignal,
  notes: string[],
): Promise<string[]> {
  const queue: string[] = [];
  for (const line of robots.sitemaps) {
    try {
      const url = new URL(line);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && sameSite(url)) {
        queue.push(url.href);
      }
    } catch {
      // A line that is not an address is skipped.
    }
  }
  const pages: string[] = [];
  const read = new Set<string>();
  let files = 0;
  while (queue.length > 0 && files < GENERATE_MAX_SITEMAPS && !signal.aborted) {
    const url = queue.shift()!;
    if (read.has(url)) continue;
    read.add(url);
    if (!(await allowed(url))) continue;
    files += 1;
    const result = await fetcher.fetchText(url, {
      kind: 'sitemap',
      signal,
      redirectAllowed: sameSite,
    });
    if (
      result.outcome !== 'response' ||
      result.status === null ||
      result.status < 200 ||
      result.status >= 300
    ) {
      continue;
    }
    const body = sitemapText(result.rawBody, result.text);
    if (body === null) continue;
    const found = sitemapLocations(body, 5_000);
    if (found.kind === 'index') {
      for (const location of found.locations) {
        try {
          const child = new URL(location);
          if (sameSite(child)) queue.push(child.href);
        } catch {
          // Skipped.
        }
      }
    } else if (found.kind === 'urlset') {
      pages.push(...found.locations);
    }
  }
  if (queue.length > 0 && files >= GENERATE_MAX_SITEMAPS) {
    notes.push(`Only the first ${GENERATE_MAX_SITEMAPS} sitemap files were read.`);
  }
  return pages;
}
