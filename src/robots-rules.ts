import {
  agentVerdict,
  CRAWLERS,
  matchRobots,
  parseRobots,
  type RobotsTxt,
} from '@queryrev/ai-readiness';
import { oneLine } from './text';
import type { Access, AccessRow, ActionFinding, Level } from './types';

// The rules the Action applies to a robots.txt change. They follow the core library's verdicts:
// a crawler for AI search or for fetching a page when a user asks (purpose `search` or `user`)
// must not get worse; a training crawler is reported and never a failure, because blocking
// those is the site's choice.

interface Group {
  readonly id: string;
  readonly level: Level;
  readonly purpose: AccessRow['purpose'];
  readonly path: string;
  readonly was: Access | null;
  readonly now: Access;
  readonly evidence: Pick<ActionFinding, 'snippet' | 'file' | 'line'>;
  readonly crawlers: string[];
}

const RANK: Readonly<Record<Access, number>> = { allowed: 0, partial: 1, blocked: 2 };

export interface RobotsComparison {
  readonly rows: readonly AccessRow[];
  readonly findings: readonly ActionFinding[];
}

/** The lines of a file, for pointing at the line that decides. */
function lineAt(text: string, line: number): string {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
  return oneLine(lines[line - 1] ?? '');
}

/** What a robots.txt says to one crawler at one path. "/" uses the whole-site verdict. */
function accessOf(robots: RobotsTxt, token: string, path: string): Access {
  if (path === '/') return agentVerdict(robots, token).access;
  return matchRobots(robots, token, path).allowed ? 'allowed' : 'blocked';
}

/**
 * Compares the robots.txt after the change with the one before it.
 *
 * - `before` is the text at the base, null when the file did not exist there (an absent
 *   robots.txt allows everything), and undefined when no base is available: then the file is
 *   judged as it stands.
 * - `after` is the text in the checkout, null when there is no file.
 *
 * With a base, a search or user-fetch crawler that gets worse (allowed to partial or blocked,
 * partial to blocked) at `/` or at a given path is a `fail`. Without one nothing got worse, so a
 * blocked or partial crawler is a `warn`; with `failWithoutBase` a blocked one is a `fail`.
 */
export function compareRobots(
  before: string | null | undefined,
  after: string | null,
  paths: readonly string[],
  file: string,
  options: { failWithoutBase?: boolean } = {},
): RobotsComparison {
  const head = parseRobots(after ?? '');
  const base = before === undefined ? null : parseRobots(before ?? '');
  const all = paths.includes('/') ? [...paths] : ['/', ...paths];
  const rows: AccessRow[] = [];
  const findings: ActionFinding[] = [];

  // Crawlers that get the same result from the same line are one finding.
  const groups = new Map<string, Group>();
  const add = (key: string, group: Omit<Group, 'crawlers'>, token: string): void => {
    const known = groups.get(key);
    if (known === undefined) groups.set(key, { ...group, crawlers: [token] });
    else known.crawlers.push(token);
  };

  for (const crawler of CRAWLERS) {
    for (const path of all) {
      const now = accessOf(head, crawler.token, path);
      const was = base === null ? null : accessOf(base, crawler.token, path);
      const worse = was !== null && RANK[now] > RANK[was];
      rows.push({
        token: crawler.token,
        vendor: crawler.vendor,
        purpose: crawler.purpose,
        path,
        before: was,
        after: now,
        worse,
      });

      const match = matchRobots(head, crawler.token, path);
      const rule = match.allowed ? null : match.rule;
      const evidence = {
        ...(rule === null || after === null ? {} : { snippet: lineAt(after, rule.line) }),
        ...(rule === null ? {} : { file, line: rule.line }),
      };
      const at = `${crawler.purpose === 'training' ? 'training' : 'access'}|${path}|${was}|${now}|${rule?.line ?? ''}`;

      if (crawler.purpose === 'training') {
        if (was !== null && was !== now) {
          add(
            `training-crawler-change|${at}`,
            {
              id: 'training-crawler-change',
              level: 'info',
              purpose: 'training',
              path,
              was,
              now,
              evidence,
            },
            crawler.token,
          );
        }
      } else if (base !== null) {
        if (worse) {
          add(
            `crawler-access-regression|${at}`,
            {
              id: 'crawler-access-regression',
              level: 'fail',
              purpose: crawler.purpose,
              path,
              was,
              now,
              evidence,
            },
            crawler.token,
          );
        } else if (now !== 'allowed') {
          add(
            `crawler-access-unchanged|${at}`,
            {
              id: 'crawler-access-unchanged',
              level: 'info',
              purpose: crawler.purpose,
              path,
              was,
              now,
              evidence,
            },
            crawler.token,
          );
        }
      } else if (now === 'blocked' || now === 'partial') {
        add(
          `crawler-access-${now}|${at}`,
          {
            id: `crawler-access-${now}`,
            level: now === 'blocked' && options.failWithoutBase === true ? 'fail' : 'warn',
            purpose: crawler.purpose,
            path,
            was,
            now,
            evidence,
          },
          crawler.token,
        );
      }
    }
  }

  for (const group of groups.values()) {
    const list = group.crawlers.join(', ');
    const kind = group.purpose === 'training' ? 'training' : 'search or user fetch';
    const message =
      group.id === 'training-crawler-change'
        ? `${list} (${kind}) at ${group.path} went from ${group.was} to ${group.now}. Blocking training crawlers is the site's choice, so this is reported and does not fail the check.`
        : group.id === 'crawler-access-unchanged'
          ? `${list} (${kind}) at ${group.path} is ${group.now === 'blocked' ? 'blocked' : 'partly blocked'}, as it was before this change.`
          : group.was === null
            ? `${list} (${kind}) at ${group.path} ${group.now === 'blocked' ? 'is blocked' : 'is partly blocked'}.`
            : `${list} (${kind}) at ${group.path} went from ${group.was} to ${group.now}.`;
    findings.push({ id: group.id, level: group.level, message, ...group.evidence });
  }

  const searchRows = rows.filter((row) => row.purpose !== 'training');
  if (!findings.some((finding) => finding.level === 'fail' || finding.level === 'warn')) {
    findings.unshift({
      id: 'crawler-access',
      level: 'pass',
      message:
        base === null
          ? `Every AI search and user-fetch crawler on the list can read ${all.join(', ')}.`
          : `No AI search or user-fetch crawler on the list got worse at ${all.join(', ')} (${searchRows.length} checks).`,
    });
  }
  return { rows, findings };
}
