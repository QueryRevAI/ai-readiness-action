/**
 * `checkSite`: reads a site's public files over the guarded fetcher and returns the facts and
 * stable findings. Requests, in order, each only if robots.txt allows this reader (its own
 * token) to make it:
 *
 * 1. `/robots.txt`
 * 2. the home page, `/`
 * 3. `/llms.txt`
 * 4. the sitemap: the first `Sitemap:` line on the same registrable domain, else `/sitemap.xml`
 *
 * A robots.txt that cannot be read ends the check: nothing else is asked. No score is given:
 * the result is facts and findings with evidence.
 */
import { crawlerAccess, crawlersCoveredLine } from '../crawlers';
import { validateLlmsTxt } from '../llms';
import {
  createTextFetcher,
  CHECK_BUDGET_MS,
  checkTextUrl,
  type TextFetcher,
  type TextFetchResult,
} from '../net/fetch-text';
import { crawlDelayFor, isAllowedByRobots, parseRobots, type RobotsTxt } from '../robots';
import { registrableDomain as defaultRegistrableDomain } from './domain';
import { readHomeResponse } from './home-response';
import { isChallenge } from './marks';
import { READER_TOKEN } from './reader';
import { readSitemap } from './sitemap';
import type {
  CheckOptions,
  Finding,
  HomeRead,
  LlmsRead,
  RobotsRead,
  SiteCheck,
  SitemapRead,
} from './types';
import { buildFindings } from './findings';

const EMPTY_ROBOTS: RobotsTxt = parseRobots('');

function sameSite(
  registrable: (host: string) => string,
  siteDomain: string,
): (target: URL) => boolean {
  return (target) => registrable(target.hostname) === siteDomain;
}

export function robotsRead(
  result: TextFetchResult,
  url: string,
): { read: RobotsRead; robots: RobotsTxt | null } {
  const base = {
    url,
    status: result.status,
    bytes: result.bytes,
    truncated: result.truncated,
  };
  const notRead = (): { read: RobotsRead; robots: null } => ({
    read: Object.freeze({
      ...base,
      outcome: 'not_read',
      sitemaps: Object.freeze([]),
      allowsThisReader: false,
    }),
    robots: null,
  });
  if (result.outcome !== 'response' || result.status === null) return notRead();
  const status = result.status;
  if (status >= 200 && status < 300) {
    if (result.text === null || isChallenge(status, result.text)) return notRead();
    const robots = parseRobots(result.text, url);
    return {
      read: Object.freeze({
        ...base,
        outcome: 'file',
        sitemaps: Object.freeze([...robots.sitemaps]),
        allowsThisReader: isAllowedByRobots(robots, READER_TOKEN, '/'),
      }),
      robots,
    };
  }
  if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) {
    return {
      read: Object.freeze({
        ...base,
        outcome: 'missing',
        sitemaps: Object.freeze([]),
        allowsThisReader: true,
      }),
      robots: EMPTY_ROBOTS,
    };
  }
  return notRead();
}

const NOT_ASKED_LLMS: LlmsRead = Object.freeze({
  asked: false,
  present: false,
  verdict: null,
  bytes: 0,
  truncated: false,
  h1: null,
  sections: 0,
  links: 0,
});

const NOT_ASKED_SITEMAP: SitemapRead = Object.freeze({
  asked: false,
  source: null,
  url: null,
  status: null,
  facts: null,
});

/** The first `Sitemap:` address on the site's registrable domain; null without one. */
function sitemapFromRobots(
  lines: readonly string[],
  registrable: (host: string) => string,
  siteDomain: string,
): string | null {
  for (const line of lines) {
    try {
      const url = new URL(line);
      if (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        registrable(url.hostname) === siteDomain
      ) {
        return url.href;
      }
    } catch {
      // A line that is not an address is skipped.
    }
  }
  return null;
}

function refused(origin: string, host: string, why: string): SiteCheck {
  const finding: Finding = Object.freeze({
    id: 'site-refused',
    level: 'fail',
    message: 'The address cannot be checked: it must be a web site name or an http(s) address.',
    docUrl: 'https://queryrev.com/research/ai-search-readiness#method',
    snippet: why,
  });
  return Object.freeze({
    schemaVersion: 1,
    origin,
    host,
    crawlersCovered: crawlersCoveredLine(),
    robots: Object.freeze({
      outcome: 'not_read',
      url: '',
      status: null,
      bytes: 0,
      truncated: false,
      sitemaps: Object.freeze([]),
      allowsThisReader: false,
    }),
    crawlerAccess: Object.freeze([]),
    home: null,
    llms: NOT_ASKED_LLMS,
    sitemap: NOT_ASKED_SITEMAP,
    findings: Object.freeze([finding]),
  });
}

/**
 * Checks a site given as a host name (`example.com`) or an http(s) address (only its scheme and
 * host are used). Never throws for what a site does or for an address that cannot be checked:
 * the result says what was read and what was not.
 */
export async function checkSite(input: string, options: CheckOptions = {}): Promise<SiteCheck> {
  const registrable = options.registrableDomain ?? defaultRegistrableDomain;
  const typed = input.trim();
  const checked = checkTextUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  if ('refusal' in checked) return refused('', '', checked.refusal);
  const origin = checked.url.origin;
  const host = checked.url.hostname;
  const siteDomain = registrable(host);

  const owned = options.fetcher === undefined;
  const fetcher: TextFetcher = options.fetcher ?? createTextFetcher();
  const budget = AbortSignal.timeout(CHECK_BUDGET_MS);
  const signal = options.signal === undefined ? budget : AbortSignal.any([options.signal, budget]);
  const redirectAllowed = sameSite(registrable, siteDomain);

  try {
    const robotsUrl = `${origin}/robots.txt`;
    const robotsResult = await fetcher.fetchText(robotsUrl, {
      kind: 'robots',
      signal,
      redirectAllowed,
    });
    const { read: robots, robots: parsed } = robotsRead(robotsResult, robotsUrl);
    let home: HomeRead | null = null;
    let llms = NOT_ASKED_LLMS;
    let sitemap = NOT_ASKED_SITEMAP;
    const access =
      parsed === null
        ? []
        : crawlerAccess(parsed).map((entry) =>
            Object.freeze({
              token: entry.crawler.token,
              purpose: entry.crawler.purpose,
              access: entry.access,
              root: entry.root.allowed,
            }),
          );

    if (parsed !== null) {
      fetcher.setCrawlDelay(host, crawlDelayFor(parsed, READER_TOKEN));
      const allowed = (path: string): boolean => isAllowedByRobots(parsed, READER_TOKEN, path);

      if (allowed('/')) {
        const homeResult = await fetcher.fetchText(`${origin}/`, {
          kind: 'page',
          signal,
          redirectAllowed,
        });
        home = readHomeResponse(homeResult, { registrableDomain: registrable });
      } else {
        home = Object.freeze({
          outcome: 'not_allowed',
          requestedUrl: `${origin}/`,
          finalUrl: `${origin}/`,
          status: null,
          redirects: 0,
          truncated: false,
          facts: null,
        });
      }

      if (allowed('/llms.txt')) {
        const result = await fetcher.fetchText(`${origin}/llms.txt`, {
          kind: 'llms',
          signal,
          redirectAllowed,
        });
        const report = validateLlmsTxt({
          status: result.outcome === 'response' ? result.status : null,
          contentType: result.contentType,
          body: result.text,
          truncated: result.truncated,
        });
        llms = Object.freeze({
          asked: true,
          present: report.present,
          verdict: report.verdict,
          bytes: report.bytes,
          truncated: report.truncated,
          h1: report.h1,
          sections: report.structure?.sections ?? 0,
          links: report.structure?.links ?? 0,
        });
      }

      const fromRobots = sitemapFromRobots(parsed.sitemaps, registrable, siteDomain);
      const sitemapUrl = fromRobots ?? `${origin}/sitemap.xml`;
      let path = '/sitemap.xml';
      try {
        const url = new URL(sitemapUrl);
        path = `${url.pathname}${url.search}`;
      } catch {
        // The address was built from a parsed one; this does not happen.
      }
      if (isAllowedByRobots(parsed, READER_TOKEN, path)) {
        const result = await fetcher.fetchText(sitemapUrl, {
          kind: 'sitemap',
          signal,
          redirectAllowed,
        });
        const ok =
          result.outcome === 'response' &&
          result.status !== null &&
          result.status >= 200 &&
          result.status < 300 &&
          result.rawBody !== null;
        sitemap = Object.freeze({
          asked: true,
          source: fromRobots === null ? 'well_known' : 'robots',
          url: sitemapUrl,
          status: result.status,
          facts: ok
            ? await readSitemap(result.rawBody, result.contentType, origin, {
                truncated: result.truncated,
                registrableDomain: registrable,
              })
            : null,
        });
      }
    }

    const site = {
      schemaVersion: 1 as const,
      origin,
      host,
      crawlersCovered: crawlersCoveredLine(),
      robots,
      crawlerAccess: Object.freeze(access),
      home,
      llms,
      sitemap,
    };
    return Object.freeze({ ...site, findings: Object.freeze(buildFindings(site)) });
  } finally {
    if (owned) await fetcher.close();
  }
}
