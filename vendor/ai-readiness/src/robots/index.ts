/**
 * robots.txt (RFC 9309). Parsing and matching are pure functions of text.
 *
 * Matching: the group whose user-agent equals the product token (case-insensitive) applies,
 * all such groups merged; otherwise the `*` groups merged; otherwise nothing is disallowed.
 * The longest matching rule wins, `allow` wins a tie. `*` matches any run of characters and a
 * final `$` anchors the end. `/robots.txt` itself is always allowed.
 */
/** Bytes of a robots.txt that are parsed (RFC 9309 asks for at least 500 KiB). */
export const ROBOTS_MAX_BYTES = 500 * 1024;
/** A robots.txt answer is used for at most this long (RFC 9309, section 2.4). */
export const ROBOTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Redirects followed for robots.txt (RFC 9309 asks for at least five). */
export const ROBOTS_MAX_REDIRECTS = 5;

export interface RobotsRule {
  readonly allow: boolean;
  /** Pattern as written, percent-encoding normalised. */
  readonly pattern: string;
  /** The rule's line in the file, counted from 1. */
  readonly line: number;
}

export interface RobotsGroup {
  /** Product tokens of the group, lower case; `*` for the catch-all. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** `Crawl-delay` in seconds when given; not part of the standard. */
  readonly crawlDelay: number | null;
  /** The line of the group's first `User-agent` line, counted from 1. */
  readonly line: number;
}

export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  /** `Sitemap:` lines, absolute URLs as written (resolved against the robots.txt URL). */
  readonly sitemaps: readonly string[];
}

const HEX = /%([0-9a-fA-F]{2})/g;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * One form for patterns and paths: non-ASCII and characters outside the URL path set
 * percent-encoded as UTF-8, escape hex upper case, escapes of unreserved characters decoded.
 * `*` and `$` in a pattern keep their meaning.
 */
function canonicalPath(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      code > 0x7e ||
      code <= 0x20 ||
      char === '"' ||
      char === '<' ||
      char === '>' ||
      char === '`'
    ) {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    } else {
      out += char;
    }
  }
  return out.replace(HEX, (escape: string, hex: string) => {
    const decoded = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
  });
}

/** The product token at the start of a `User-agent` value (`Googlebot/2.1` → `googlebot`). */
function agentToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('*')) return '*';
  const match = /^[A-Za-z_-]+/.exec(trimmed);
  return match ? match[0].toLowerCase() : '';
}

/**
 * Parses a robots.txt body. Never throws; unknown lines are ignored. A group is a run of
 * user-agent lines and the rules after it; only an Allow or Disallow line ends the run, so a
 * Sitemap, Crawl-delay or unknown line between two user-agent lines does not split the group.
 */
export function parseRobots(body: string, robotsUrl?: string): RobotsTxt {
  let text = body.length > ROBOTS_MAX_BYTES ? body.slice(0, ROBOTS_MAX_BYTES) : body;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const groups: {
    agents: string[];
    rules: RobotsRule[];
    crawlDelay: number | null;
    line: number;
  }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  let lineNumber = 0;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    lineNumber += 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case 'user-agent': {
        const token = agentToken(value);
        if (!lastWasAgent || current === null) {
          current = { agents: [], rules: [], crawlDelay: null, line: lineNumber };
          groups.push(current);
        }
        if (token !== '') current.agents.push(token);
        lastWasAgent = true;
        break;
      }
      case 'allow':
      case 'disallow': {
        lastWasAgent = false;
        // An empty value is no rule; a pattern must start with `/` or `*`.
        if (current === null || value === '') break;
        if (!value.startsWith('/') && !value.startsWith('*')) break;
        current.rules.push({
          allow: key === 'allow',
          pattern: canonicalPath(value),
          line: lineNumber,
        });
        break;
      }
      case 'crawl-delay': {
        // Not a rule (Google ignores the line), so it does not end a run of user-agent lines;
        // within one group the longest delay given is kept.
        const seconds = Number(value);
        if (current !== null && Number.isFinite(seconds) && seconds >= 0)
          current.crawlDelay = Math.max(current.crawlDelay ?? 0, seconds);
        break;
      }
      case 'sitemap': {
        // Sitemap lines belong to no group and do not end one.
        try {
          sitemaps.push(new URL(value, robotsUrl).href);
        } catch {
          // An unusable sitemap line is ignored.
        }
        break;
      }
      default:
      // Any other line (Content-Signal, Host, Clean-param, a typo) is ignored, as Google's
      // parser ignores it: it neither ends a run of user-agent lines nor starts a group.
    }
  }
  return Object.freeze({
    groups: Object.freeze(
      groups.map((group) =>
        Object.freeze({
          agents: Object.freeze(group.agents),
          rules: Object.freeze(group.rules),
          crawlDelay: group.crawlDelay,
          line: group.line,
        }),
      ),
    ),
    sitemaps: Object.freeze([...new Set(sitemaps)]),
  });
}

/** Whether a pattern matches the start of a path (RFC 9309 2.2.3). */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');
  // The first part must match at the start.
  if (!path.startsWith(parts[0]!)) return false;
  let position = parts[0]!.length;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (index === parts.length - 1 && anchored) {
      // The last part must end the path, and must start at or after `position`.
      return path.length - part.length >= position && path.endsWith(part);
    }
    const found = path.indexOf(part, position);
    if (found === -1) return false;
    position = found + part.length;
  }
  return anchored ? position === path.length : true;
}

/** The groups that apply to a product token, merged (RFC 9309 2.2.1). */
function groupsFor(robots: RobotsTxt, productToken: string): RobotsGroup[] {
  const token = productToken.toLowerCase();
  const exact = robots.groups.filter((group) => group.agents.includes(token));
  if (exact.length > 0) return exact;
  return robots.groups.filter((group) => group.agents.includes('*'));
}

/**
 * Which rule decides a path for a product token, and through which group.
 *
 * - `via`: `named` when a group names the token, `catch_all` when the `*` group applies, `none`
 *   when no group applies (everything is allowed).
 * - `group`: the first applying group's line and agents (several groups that name the token
 *   are merged; the one that holds the deciding rule is given when a rule decides).
 * - `rule`: the deciding rule, or null when no rule matches (allowed).
 */
export interface RuleMatch {
  readonly allowed: boolean;
  readonly via: 'named' | 'catch_all' | 'none';
  readonly group: { readonly line: number; readonly agents: readonly string[] } | null;
  readonly rule: RobotsRule | null;
}

const NO_RULE = Object.freeze({ best: null, bestGroup: null });

interface Decided {
  readonly best: RobotsRule | null;
  readonly bestGroup: RobotsGroup | null;
}

/**
 * The deciding rule for a set of groups and a path, computed once per robots.txt: agents that
 * share their groups (several named in one group, or all on the catch-all) and repeated
 * questions reuse it, so a file of many rules is matched about once per path, not once per
 * agent. Kept with the parsed file and dropped with it.
 */
const DECIDED = new WeakMap<
  RobotsTxt,
  { index: Map<RobotsGroup, number>; rules: Map<string, Decided> }
>();

function decidingRule(robots: RobotsTxt, groups: readonly RobotsGroup[], path: string): Decided {
  let cache = DECIDED.get(robots);
  if (cache === undefined) {
    cache = {
      index: new Map(robots.groups.map((group, index) => [group, index])),
      rules: new Map(),
    };
    DECIDED.set(robots, cache);
  }
  const key = `${groups.map((group) => cache.index.get(group)).join(',')}|${path}`;
  const known = cache.rules.get(key);
  if (known !== undefined) return known;
  let best: RobotsRule | null = null;
  let bestGroup: RobotsGroup | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, path)) continue;
      if (
        best === null ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
        bestGroup = group;
      }
    }
  }
  const decided = Object.freeze({ best, bestGroup });
  cache.rules.set(key, decided);
  return decided;
}

export function matchRobots(
  robots: RobotsTxt,
  productToken: string,
  pathAndQuery: string,
): RuleMatch {
  const token = productToken.toLowerCase();
  const groups = groupsFor(robots, token);
  const via: RuleMatch['via'] =
    groups.length === 0
      ? 'none'
      : token !== '*' && groups[0]!.agents.includes(token)
        ? 'named'
        : 'catch_all';
  const path = canonicalPath(pathAndQuery === '' ? '/' : pathAndQuery);
  const { best, bestGroup } = path === '/robots.txt' ? NO_RULE : decidingRule(robots, groups, path);
  const shown = bestGroup ?? groups[0] ?? null;
  return Object.freeze({
    allowed: best === null || best.allow,
    via,
    group: shown === null ? null : Object.freeze({ line: shown.line, agents: shown.agents }),
    rule: best,
  });
}

/**
 * Whether robots.txt allows a URL path (path plus `?query`, as sent in the request line) for
 * a product token.
 */
export function isAllowedByRobots(
  robots: RobotsTxt,
  productToken: string,
  pathAndQuery: string,
): boolean {
  return matchRobots(robots, productToken, pathAndQuery).allowed;
}

/** `Crawl-delay` for a product token, in seconds; null when none is set. */
export function crawlDelayFor(robots: RobotsTxt, productToken: string): number | null {
  const delays = groupsFor(robots, productToken)
    .map((group) => group.crawlDelay)
    .filter((delay): delay is number => delay !== null);
  return delays.length === 0 ? null : Math.max(...delays);
}
