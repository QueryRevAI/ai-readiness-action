import {
  isAllowedByRobots,
  matchRobots,
  type RobotsGroup,
  type RobotsTxt,
  type RuleMatch,
} from '../robots';

/**
 * Which AI crawlers are measured, and what a robots.txt says to each of them. Nothing outside
 * `STUDY_AGENTS` is measured or named.
 */

/**
 * The product tokens measured, and the catch-all. The study names the vendors it measures on its
 * page; any crawler not listed here is neither measured nor named.
 */
export const STUDY_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Meta-ExternalAgent',
  'Amazonbot',
  'Bytespider',
  '*',
] as const;
export type StudyAgent = (typeof STUDY_AGENTS)[number];
export type AiAgent = Exclude<StudyAgent, '*'>;

/** The AI agents (every measured token but the catch-all). */
export const AI_AGENTS = STUDY_AGENTS.filter((agent): agent is AiAgent => agent !== '*');

/**
 * What the rules of a robots.txt mean for one agent, read with the group that applies to it
 * (its own named group, otherwise the `*` group; RFC 9309 2.2.1):
 *
 * - `blocked`: the whole site is closed to it: a rule for the whole site (`/`, `/*`, `*`)
 *   disallows `/` and no narrower `Allow` rule opens any other path.
 * - `partial`: some of the site is closed to it: `/` is disallowed but an `Allow` rule opens some
 *   paths, or `/` is disallowed only by a narrower rule (`Disallow: /$` closes the home page,
 *   not the site); or `/` is open but the group that applies also disallows the whole site (an
 *   `Allow: /$` exception to `Disallow: /`); or the agent has a group of its own that disallows
 *   a path the `*` group does not. (Paths a site keeps from every crawler, under `*`, are
 *   housekeeping: an agent that inherits them, or whose own group repeats them, is `allowed`.)
 * - `allowed`: anything else, a missing robots.txt included.
 *
 * `named` tells a rule written for the agent from one it inherits from `*`.
 */
export type AgentAccess = 'allowed' | 'partial' | 'blocked';

export interface AgentVerdict {
  readonly access: AgentAccess;
  /** The robots.txt has a group naming this agent's product token (never true for `*`). */
  readonly named: boolean;
  /** Whether the rules that apply to the agent let it fetch `/llms.txt`. */
  readonly llmsTxt: boolean;
}

/** A pattern that matches every path: `/`, `/*` or `*`. */
function wholeSite(pattern: string): boolean {
  return pattern === '/' || pattern === '/*' || pattern === '*';
}

/**
 * Verdicts depend only on the groups that apply, so they are kept per parsed file and per set
 * of groups: agents named together, or all left to the catch-all, share one computation, and a
 * large file is read about once whatever the number of agents asked about.
 */
const VERDICTS = new WeakMap<
  RobotsTxt,
  {
    index: Map<RobotsGroup, number>;
    housekeeping: Set<string> | null;
    byGroups: Map<string, AgentVerdict>;
  }
>();

function memoFor(robots: RobotsTxt) {
  let memo = VERDICTS.get(robots);
  if (memo === undefined) {
    memo = {
      index: new Map(robots.groups.map((group, index) => [group, index])),
      housekeeping: null,
      byGroups: new Map(),
    };
    VERDICTS.set(robots, memo);
  }
  return memo;
}

export function agentVerdict(robots: RobotsTxt, agent: string): AgentVerdict {
  const token = agent.toLowerCase();
  const own = token === '*' ? [] : robots.groups.filter((group) => group.agents.includes(token));
  const named = own.length > 0;
  const memo = memoFor(robots);
  const key = named ? own.map((group) => memo.index.get(group)).join(',') : '*';
  const known = memo.byGroups.get(key);
  if (known !== undefined) return known;
  const verdict = computeVerdict(robots, agent, own, named, memo);
  memo.byGroups.set(key, verdict);
  return verdict;
}

function computeVerdict(
  robots: RobotsTxt,
  agent: string,
  own: readonly RobotsGroup[],
  named: boolean,
  memo: ReturnType<typeof memoFor>,
): AgentVerdict {
  const groups = named ? own : robots.groups.filter((group) => group.agents.includes('*'));
  const rules = groups.flatMap((group) => group.rules);
  const as = named ? agent : '*';
  const rootAllowed = isAllowedByRobots(robots, as, '/');
  const allows = rules.filter((rule) => rule.allow);
  const disallows = rules.filter((rule) => !rule.allow);
  let access: AgentAccess;
  if (!rootAllowed) {
    // `/` closed by a rule narrower than the whole site (`Disallow: /$`) leaves the rest open.
    // A rule for the whole site that won at `/` wins at every path: only a narrower Allow opens
    // anything.
    const whole = disallows.some((rule) => wholeSite(rule.pattern));
    access = !whole || allows.some((rule) => !wholeSite(rule.pattern)) ? 'partial' : 'blocked';
  } else if (disallows.some((rule) => wholeSite(rule.pattern))) {
    // `/` itself is open, yet a rule closes the whole site: `Allow: /` ties it and wins (open),
    // anything narrower (`Allow: /$`) leaves the rest closed.
    access = allows.some((rule) => wholeSite(rule.pattern)) ? 'allowed' : 'partial';
  } else {
    // A group of its own replaces the catch-all, so a site that names a crawler often repeats
    // its housekeeping there (/search, /cart). Only a path the catch-all leaves open, closed
    // for this crawler, is a choice about it.
    memo.housekeeping ??= new Set(
      robots.groups
        .filter((group) => group.agents.includes('*'))
        .flatMap((group) => group.rules)
        .filter((rule) => !rule.allow)
        .map((rule) => rule.pattern),
    );
    const housekeeping = memo.housekeeping;
    access =
      named && disallows.some((rule) => !housekeeping.has(rule.pattern)) ? 'partial' : 'allowed';
  }
  return Object.freeze({ access, named, llmsTxt: isAllowedByRobots(robots, as, '/llms.txt') });
}

/** The verdicts of every measured agent for one robots.txt. */
export function verdictsFor(robots: RobotsTxt): Record<StudyAgent, AgentVerdict> {
  return Object.fromEntries(
    STUDY_AGENTS.map((agent) => [agent, agentVerdict(robots, agent)]),
  ) as Record<StudyAgent, AgentVerdict>;
}

/** What a crawler is for: collecting pages for AI training, indexing for AI search, or fetching a page when a user asks. */
export type CrawlerPurpose = 'training' | 'search' | 'user';

/** The purposes, in the order they are listed. */
export const CRAWLER_PURPOSES: readonly CrawlerPurpose[] = ['training', 'search', 'user'];

export interface CrawlerInfo {
  /** The product token of the crawler, as it is written in a `User-agent` line. */
  readonly token: AiAgent;
  readonly vendor: string;
  readonly purpose: CrawlerPurpose;
}

/** The crawlers covered, in the order of `AI_AGENTS`. No other crawler is measured or named. */
export const CRAWLERS: readonly CrawlerInfo[] = Object.freeze([
  { token: 'GPTBot', vendor: 'OpenAI', purpose: 'training' },
  { token: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user' },
  { token: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search' },
  { token: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user' },
  { token: 'Google-Extended', vendor: 'Google', purpose: 'training' },
  { token: 'Applebot-Extended', vendor: 'Apple', purpose: 'training' },
  { token: 'CCBot', vendor: 'Common Crawl', purpose: 'training' },
  { token: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training' },
  { token: 'Amazonbot', vendor: 'Amazon', purpose: 'search' },
  { token: 'Bytespider', vendor: 'ByteDance', purpose: 'training' },
]);

/** The vendors of the crawlers covered, each once, in the order of `CRAWLERS`. */
function coveredVendors(): string[] {
  return [...new Set(CRAWLERS.map((crawler) => crawler.vendor))];
}

/**
 * The scope line every report carries: which crawlers were checked. A report never claims
 * to cover every AI crawler.
 */
export function crawlersCoveredLine(): string {
  const vendors = coveredVendors();
  const list = `${vendors.slice(0, -1).join(', ')} and ${vendors[vendors.length - 1]!}`;
  return `Crawlers covered: the ${CRAWLERS.length} AI crawlers on this list, from ${list}. Other crawlers are not checked.`;
}

/** What a robots.txt says to one covered crawler, for the site and for one path. */
export interface CrawlerAccess {
  readonly crawler: CrawlerInfo;
  /** The verdict for the whole site (see `agentVerdict`). */
  readonly access: AgentAccess;
  readonly named: boolean;
  /** The rule that decides `/`. */
  readonly root: RuleMatch;
  /** The rule that decides the path asked about; null when no path other than `/` was asked. */
  readonly path: RuleMatch | null;
  /** Whether the crawler may fetch `/llms.txt`. */
  readonly llmsTxt: boolean;
}

/**
 * The access of every covered crawler: the verdict for the site, and the deciding rule for `/`
 * and for `path` (a path and query, such as `/blog/post?x=1`). A missing robots.txt is an
 * empty one: pass `parseRobots('')`.
 */
export function crawlerAccess(robots: RobotsTxt, options: { path?: string } = {}): CrawlerAccess[] {
  const path = options.path ?? '/';
  return CRAWLERS.map((crawler) => {
    const verdict = agentVerdict(robots, crawler.token);
    return Object.freeze({
      crawler,
      access: verdict.access,
      named: verdict.named,
      root: matchRobots(robots, crawler.token, '/'),
      path: path === '/' ? null : matchRobots(robots, crawler.token, path),
      llmsTxt: verdict.llmsTxt,
    });
  });
}
