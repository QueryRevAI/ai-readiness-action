import { appendFile } from 'node:fs/promises';
import { escapeData, escapeProperty } from './text';
import type { ActionFinding } from './types';

/**
 * The first line of the one comment this Action writes. The Action finds its comment by this
 * line and updates it, so a pull request never gets a second one.
 */
export const COMMENT_MARKER = '<!-- queryrev-ai-readiness-action -->';

/** GitHub refuses a comment body over 65536 characters; a job summary over 1 MiB. */
export const COMMENT_LIMIT = 60_000;
export const SUMMARY_LIMIT = 900_000;

const USER_AGENT = 'queryrev-ai-readiness-action';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

export type Env = Readonly<Record<string, string | undefined>>;

/** Appends Markdown to the job summary. Does nothing outside a workflow run. */
export async function writeSummary(env: Env, markdown: string): Promise<void> {
  const file = env['GITHUB_STEP_SUMMARY'];
  if (file === undefined || file === '') return;
  await appendFile(file, `${cut(markdown, SUMMARY_LIMIT)}\n`);
}

/** Sets a step output. Values are single-line. */
export async function setOutput(env: Env, name: string, value: string): Promise<void> {
  const file = env['GITHUB_OUTPUT'];
  if (file === undefined || file === '') return;
  await appendFile(file, `${name}=${value.replace(/[\r\n]+/g, ' ')}\n`);
}

/** A workflow command line that annotates a file of the pull request. */
export function annotation(
  level: 'error' | 'warning' | 'notice',
  finding: Pick<ActionFinding, 'message' | 'file' | 'line'>,
  title: string,
): string {
  const properties = [
    ...(finding.file === undefined ? [] : [`file=${escapeProperty(finding.file)}`]),
    ...(finding.file === undefined || finding.line === undefined ? [] : [`line=${finding.line}`]),
    `title=${escapeProperty(title)}`,
  ];
  return `::${level} ${properties.join(',')}::${escapeData(finding.message)}`;
}

export function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 80).trimEnd()}\n\n_The report was cut here because of GitHub's size limit._`;
}

export interface PullRequestContext {
  readonly apiUrl: string;
  /** "owner/name" */
  readonly repository: string;
  readonly number: number;
  /**
   * The pull request comes from another repository. The token of a run for such a pull request
   * is read-only, so the comment is not attempted.
   */
  readonly fork: boolean;
}

/**
 * The pull request this run belongs to, from the environment GitHub sets. Null when the run is
 * not for a pull request, and there is no comment to write.
 */
export function pullRequestFrom(env: Env, event: unknown): PullRequestContext | null {
  if (env['GITHUB_EVENT_NAME'] !== 'pull_request') return null;
  const pr = (
    event as {
      pull_request?: {
        number?: unknown;
        head?: { repo?: { full_name?: unknown } | null };
        base?: { repo?: { full_name?: unknown } | null };
      };
    } | null
  )?.pull_request;
  const number = pr?.number;
  const repository = env['GITHUB_REPOSITORY'] ?? '';
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  const apiUrl = (env['GITHUB_API_URL'] ?? 'https://api.github.com').replace(/\/+$/, '');
  // A head repository that is missing (a deleted fork) or differs from the base is a fork.
  const head = pr?.head?.repo?.full_name;
  const named = pr?.base?.repo?.full_name;
  const baseName = typeof named === 'string' ? named : repository;
  const fork = typeof head !== 'string' || head.toLowerCase() !== baseName.toLowerCase();
  return { apiUrl, repository, number, fork };
}

export type CommentResult =
  | { readonly outcome: 'created' | 'updated'; readonly id: number }
  | { readonly outcome: 'skipped'; readonly reason: string };

interface ExistingComment {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

/** The author of the comments this token writes: the Actions bot for the default token. */
const DEFAULT_AUTHOR = { login: 'github-actions[bot]', type: 'Bot' } as const;

export interface CommentOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/**
 * Writes the one comment, or updates it. This is the only place the token is used and the only
 * network call the Action makes unless `site-url` is set. A failure (a read-only token on a pull
 * request from a fork, a missing permission, no network) is returned, never thrown: the report is
 * in the job summary either way.
 */
export async function upsertComment(
  pull: PullRequestContext,
  body: string,
  options: CommentOptions,
): Promise<CommentResult> {
  if (pull.fork) {
    return {
      outcome: 'skipped',
      reason:
        'this pull request comes from a fork, whose token is read-only, so no comment is attempted',
    };
  }
  const send = options.fetch ?? fetch;
  let api: URL;
  try {
    api = new URL(pull.apiUrl);
  } catch {
    return { outcome: 'skipped', reason: 'the GitHub API address is not valid' };
  }
  if (api.protocol !== 'https:') {
    return { outcome: 'skipped', reason: 'the GitHub API address is not https' };
  }
  const apiRoot = pull.apiUrl;
  const base = `${pull.apiUrl}/repos/${pull.repository}/issues`;
  const request = async (url: string, init: RequestInit): Promise<Response> =>
    send(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  const text = body.startsWith(COMMENT_MARKER) ? body : `${COMMENT_MARKER}\n${body}`;
  const payload = JSON.stringify({ body: cut(text, COMMENT_LIMIT) });

  try {
    // The author of the comments this token writes. The default token cannot ask who it is
    // (GET /user is refused to an installation token), and writes as the Actions bot; a personal
    // access token or another credential answers with its own login.
    const me = await request(`${apiRoot}/user`, { method: 'GET' });
    let author: { login: string; type: string } = DEFAULT_AUTHOR;
    if (me.ok) {
      const who = (await me.json()) as { login?: unknown; type?: unknown };
      if (typeof who.login === 'string' && typeof who.type === 'string') {
        author = { login: who.login, type: who.type };
      }
    }

    const candidates: ExistingComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await request(`${base}/${pull.number}/comments?per_page=100&page=${page}`, {
        method: 'GET',
      });
      if (!response.ok)
        return { outcome: 'skipped', reason: `listing comments answered ${response.status}` };
      const list: unknown = await response.json();
      if (!Array.isArray(list))
        return { outcome: 'skipped', reason: 'listing comments gave no list' };
      for (const item of list as {
        id?: unknown;
        body?: unknown;
        user?: { login?: unknown; type?: unknown };
      }[]) {
        if (
          typeof item.id === 'number' &&
          typeof item.body === 'string' &&
          item.body.startsWith(COMMENT_MARKER)
        ) {
          candidates.push({
            id: item.id,
            login: typeof item.user?.login === 'string' ? item.user.login : '',
            type: typeof item.user?.type === 'string' ? item.user.type : '',
          });
        }
      }
      if (list.length < 100) break;
    }

    // Anyone can write the marker into a comment of their own, so only a comment written by
    // this token's own identity is updated, the oldest first. A comment by any other author is
    // left alone, and when there is no comment of ours a new one is written.
    const own = candidates.filter(
      (candidate) =>
        candidate.login.toLowerCase() === author.login.toLowerCase() &&
        candidate.type === author.type,
    );
    for (const candidate of own) {
      const response = await request(`${base}/comments/${candidate.id}`, {
        method: 'PATCH',
        body: payload,
      });
      if (response.ok) return { outcome: 'updated', id: candidate.id };
      if (response.status !== 404) {
        return { outcome: 'skipped', reason: `updating the comment answered ${response.status}` };
      }
    }

    const response = await request(`${base}/${pull.number}/comments`, {
      method: 'POST',
      body: payload,
    });
    if (!response.ok) {
      return {
        outcome: 'skipped',
        reason:
          response.status === 403
            ? 'the token cannot write comments (a pull request from a fork gets a read-only token, or the job lacks pull-requests: write)'
            : `writing the comment answered ${response.status}`,
      };
    }
    const created = (await response.json()) as { id?: unknown };
    return { outcome: 'created', id: typeof created.id === 'number' ? created.id : 0 };
  } catch (error) {
    return {
      outcome: 'skipped',
      reason: `the request failed (${error instanceof Error ? error.name : 'error'})`,
    };
  }
}
