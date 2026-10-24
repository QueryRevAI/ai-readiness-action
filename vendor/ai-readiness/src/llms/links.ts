/**
 * Checking the links of an llms.txt: the first 20 that point at the same site, each fetched with
 * GET (the body read to 64 KiB), no faster than the fetcher's one request a second per host
 * (slower where robots.txt sets a `Crawl-delay`, up to 10 seconds), and only where the robots.txt
 * of the link's own origin lets this reader in. The run has 30 seconds; links not yet asked when
 * it ends are reported as not checked.
 */
import { registrableDomain } from '../facts/domain';
import { createOriginRobots } from '../facts/origin-robots';
import type { Finding } from '../facts/types';
import { CHECK_BUDGET_MS, type TextFetcher } from '../net/fetch-text';
import { llmsFinding } from './findings';

/** Links checked in one run. */
export const LLMS_LINKS_MAX = 20;
/** Bytes of each linked page that are read. */
export const LLMS_LINK_BODY_BYTES = 64 * 1024;

export type LlmsLinkOutcome =
  /** A 2xx answer (after at most 3 redirects on the same site). */
  | 'ok'
  /** 404 or 410. */
  | 'missing'
  /** Another 4xx or 5xx answer. */
  | 'error_status'
  /** No answer, a refused address, a redirect off the site, or a loop. */
  | 'unreachable'
  /** The robots.txt of the link's own origin keeps this reader from it, so it was not requested. */
  | 'not_allowed'
  /** The robots.txt of the link's own origin could not be read, so the link was not requested. */
  | 'robots_unreadable'
  /** The time budget ran out before the link was asked. */
  | 'not_checked';

export interface LlmsLinkResult {
  /** The link as an absolute address. */
  readonly url: string;
  readonly outcome: LlmsLinkOutcome;
  readonly status: number | null;
}

export interface LlmsLinksReport {
  /** Links in the file that were not checked because they point at another site or are not web addresses. */
  readonly skipped: number;
  /** Links in the file beyond the first 20 that were left unchecked. */
  readonly beyondLimit: number;
  /** False when robots.txt could not be read, so no link was requested. */
  readonly robotsRead: boolean;
  readonly results: readonly LlmsLinkResult[];
}

export interface CheckLlmsLinksOptions {
  readonly fetcher: TextFetcher;
  /** The site's address; relative links are resolved against it, and only its site is checked. */
  readonly base: string;
  readonly signal?: AbortSignal;
  readonly registrableDomain?: (host: string) => string;
}

/** The distinct http(s) addresses among the targets, resolved against `base`, fragments removed. */
function resolveTargets(
  targets: readonly string[],
  base: URL,
  sameSite: (url: URL) => boolean,
): { onSite: string[]; skipped: number } {
  const seen = new Set<string>();
  const onSite: string[] = [];
  let skipped = 0;
  for (const target of targets) {
    let url: URL;
    try {
      url = new URL(target, base);
    } catch {
      skipped += 1;
      continue;
    }
    url.hash = '';
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !sameSite(url)) {
      skipped += 1;
      continue;
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    onSite.push(url.href);
  }
  return { onSite, skipped };
}

export async function checkLlmsLinks(
  targets: readonly string[],
  options: CheckLlmsLinksOptions,
): Promise<LlmsLinksReport> {
  const registrable = options.registrableDomain ?? registrableDomain;
  const base = new URL(options.base);
  const siteDomain = registrable(base.hostname);
  const { onSite, skipped } = resolveTargets(
    targets,
    base,
    (url) => registrable(url.hostname) === siteDomain,
  );
  const chosen = onSite.slice(0, LLMS_LINKS_MAX);
  const beyondLimit = onSite.length - chosen.length;
  if (chosen.length === 0) return { skipped, beyondLimit, robotsRead: true, results: [] };

  // Every origin is asked on its own robots.txt: a link on a subdomain or on the other scheme
  // is not covered by the base origin's file.
  const budget = AbortSignal.timeout(CHECK_BUDGET_MS);
  const signal = options.signal === undefined ? budget : AbortSignal.any([options.signal, budget]);
  const sameSite = (target: URL): boolean => registrable(target.hostname) === siteDomain;
  const origins = createOriginRobots({
    fetcher: options.fetcher,
    signal,
    redirectAllowed: sameSite,
  });
  if ((await origins.robotsOf(base.origin)) === null) {
    return { skipped, beyondLimit, robotsRead: false, results: [] };
  }

  const results: LlmsLinkResult[] = [];
  let outOfTime = false;
  for (const url of chosen) {
    if (outOfTime || signal.aborted) {
      outOfTime = true;
      results.push({ url, outcome: 'not_checked', status: null });
      continue;
    }
    const access = await origins.check(url);
    if (signal.aborted) {
      outOfTime = true;
      results.push({ url, outcome: 'not_checked', status: null });
      continue;
    }
    if (access !== 'allowed') {
      results.push({
        url,
        outcome: access === 'closed' ? 'not_allowed' : 'robots_unreadable',
        status: null,
      });
      continue;
    }
    const result = await options.fetcher.fetchText(url, {
      kind: 'page',
      maxBytes: LLMS_LINK_BODY_BYTES,
      signal,
      redirectAllowed: sameSite,
    });
    if (result.outcome === 'budget_exceeded') {
      outOfTime = true;
      results.push({ url, outcome: 'not_checked', status: null });
      continue;
    }
    const status = result.outcome === 'response' ? result.status : null;
    const outcome: LlmsLinkOutcome =
      status === null
        ? 'unreachable'
        : status >= 200 && status < 300
          ? 'ok'
          : status === 404 || status === 410
            ? 'missing'
            : 'error_status';
    results.push({ url, outcome, status });
  }
  return { skipped, beyondLimit, robotsRead: true, results };
}

/** The findings of a link check. One finding for the set; the evidence lists what is wrong. */
export function llmsLinkFindings(report: LlmsLinksReport): Finding[] {
  if (!report.robotsRead) {
    return [
      llmsFinding(
        'llms-txt-links',
        'warn',
        'robots.txt could not be read, so no link was requested.',
      ),
    ];
  }
  if (report.results.length === 0) {
    return [llmsFinding('llms-txt-links', 'info', 'The file has no link on this site to check.')];
  }
  const notRequested = new Set<LlmsLinkOutcome>([
    'not_allowed',
    'robots_unreadable',
    'not_checked',
  ]);
  const checked = report.results.filter((entry) => !notRequested.has(entry.outcome));
  const missing = checked.filter((entry) => entry.outcome === 'missing');
  const other = checked.filter(
    (entry) => entry.outcome === 'error_status' || entry.outcome === 'unreachable',
  );
  const notAllowed = report.results.filter(
    (entry) => entry.outcome === 'not_allowed' || entry.outcome === 'robots_unreadable',
  ).length;
  const notChecked = report.results.filter((entry) => entry.outcome === 'not_checked').length;
  const list = (entries: readonly LlmsLinkResult[]): string =>
    entries
      .slice(0, 5)
      .map((entry) => `${entry.status ?? 'no answer'} ${entry.url}`)
      .join('\n');
  const tail = [
    notAllowed > 0 ? `${notAllowed} not requested (robots.txt)` : '',
    notChecked > 0 ? `${notChecked} not checked (time budget)` : '',
    report.beyondLimit > 0 ? `${report.beyondLimit} beyond the first ${LLMS_LINKS_MAX}` : '',
  ]
    .filter((part) => part !== '')
    .join('; ');
  const suffix = tail === '' ? '' : ` (${tail})`;
  if (checked.length === 0) {
    return [
      llmsFinding(
        'llms-txt-links',
        notChecked > 0 ? 'warn' : 'info',
        `No link was requested${suffix}.`,
      ),
    ];
  }
  if (missing.length > 0) {
    return [
      llmsFinding(
        'llms-txt-links',
        'fail',
        `${missing.length} of ${checked.length} checked links answer 404 or 410${suffix}.`,
        list(missing),
      ),
    ];
  }
  if (other.length > 0) {
    return [
      llmsFinding(
        'llms-txt-links',
        'warn',
        `${other.length} of ${checked.length} checked links did not answer with a 2xx${suffix}.`,
        list(other),
      ),
    ];
  }
  return [
    llmsFinding(
      'llms-txt-links',
      'pass',
      `All ${checked.length} checked link${checked.length === 1 ? '' : 's'} on this site answer 2xx${suffix}.`,
    ),
  ];
}
