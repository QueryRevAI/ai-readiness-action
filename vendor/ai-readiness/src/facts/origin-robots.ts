/**
 * robots.txt per origin. An address on a subdomain, or on the other scheme, is a different
 * origin with its own robots.txt: before this tool requests anything there, it reads that
 * origin's file once and asks whether its own token may fetch the path. Answers are kept for
 * the run.
 */
import { crawlDelayFor, isAllowedByRobots, type RobotsTxt } from '../robots';
import { MAX_CRAWL_DELAY_SECONDS, type TextFetcher } from '../net/fetch-text';
import { robotsRead } from './check-site';
import { READER_TOKEN } from './reader';

export type OriginAccess = 'allowed' | 'closed' | 'unreadable';

export interface OriginRobots {
  /** The parsed robots.txt of an origin (a missing file is an empty one); null when unreadable. */
  robotsOf(origin: string): Promise<RobotsTxt | null>;
  /** Whether this tool's token may fetch the address, by the robots.txt of the address's origin. */
  check(url: string): Promise<OriginAccess>;
}

export function createOriginRobots(options: {
  readonly fetcher: TextFetcher;
  readonly signal?: AbortSignal;
  readonly redirectAllowed?: (target: URL) => boolean;
}): OriginRobots {
  const known = new Map<string, Promise<RobotsTxt | null>>();

  const robotsOf = (origin: string): Promise<RobotsTxt | null> => {
    const cached = known.get(origin);
    if (cached !== undefined) return cached;
    const url = `${origin}/robots.txt`;
    const read = options.fetcher
      .fetchText(url, {
        kind: 'robots',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.redirectAllowed === undefined
          ? {}
          : { redirectAllowed: options.redirectAllowed }),
      })
      .then((result) => {
        const { robots } = robotsRead(result, url);
        if (robots !== null) {
          const delay = crawlDelayFor(robots, READER_TOKEN);
          options.fetcher.setCrawlDelay(
            new URL(origin).hostname,
            delay === null ? null : Math.min(delay, MAX_CRAWL_DELAY_SECONDS),
          );
        }
        return robots;
      });
    known.set(origin, read);
    return read;
  };

  return {
    robotsOf,
    async check(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return 'closed';
      }
      const robots = await robotsOf(parsed.origin);
      if (robots === null) return 'unreadable';
      return isAllowedByRobots(robots, READER_TOKEN, `${parsed.pathname}${parsed.search}`)
        ? 'allowed'
        : 'closed';
    },
  };
}
