import { checkSite, createTextFetcher, type SiteCheck } from '@queryrev/ai-readiness';
import type { ActionFinding } from './types';

/** The result of the optional online check. */
export interface OnlineResult {
  readonly origin: string;
  readonly findings: readonly ActionFinding[];
  /** Why the site could not be read, or null. */
  readonly unreadable: string | null;
}

function unreadableReason(site: SiteCheck): string | null {
  if (site.findings.some((finding) => finding.id === 'site-refused')) {
    return site.findings[0]?.snippet ?? 'the address cannot be checked';
  }
  if (site.robots.outcome === 'not_read') {
    return site.robots.status === null
      ? 'no answer to the request for robots.txt'
      : `robots.txt answered ${site.robots.status}`;
  }
  return null;
}

/**
 * The online check: the core library's `checkSite` against the live site, with its network
 * rules (public addresses only, ports 80 and 443, redirects and sizes capped, one request a
 * second to a host, robots.txt asked first). It is imported only when `site-url` is set.
 */
export async function runOnlineCheck(siteUrl: string): Promise<OnlineResult> {
  const fetcher = createTextFetcher();
  let site: SiteCheck;
  try {
    site = await checkSite(siteUrl, { fetcher });
  } finally {
    await fetcher.close();
  }
  return {
    origin: site.origin === '' ? siteUrl : site.origin,
    unreadable: unreadableReason(site),
    findings: site.findings.map((finding) => ({
      id: finding.id,
      level: finding.level,
      message: finding.message,
      ...(finding.snippet === undefined ? {} : { snippet: finding.snippet }),
    })),
  };
}
