import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMENT_MARKER } from './github';
import { fakeGitHub } from './github.testkit';
import { run } from './run';

const online = vi.hoisted(() => vi.fn());
vi.mock('./online', () => ({ runOnlineCheck: online }));

const GOOD_LLMS =
  '# Example\n\n> A site about examples.\n\n## Docs\n- [Start](https://www.example.com/start)\n';
const OPEN = 'User-agent: *\nAllow: /\n';
const CLOSED = 'User-agent: *\nDisallow: /\n';

let dir: string;
let lines: string[];

const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();

function write(path: string, text: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** A repository with a base commit holding the given files; returns the base commit. */
function repoWith(files: Record<string, string>): string {
  git('init', '-q');
  for (const [path, text] of Object.entries(files)) write(path, text);
  git('add', '-A');
  git('commit', '-qm', 'base');
  return git('rev-parse', 'HEAD');
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_WORKSPACE: dir,
    GITHUB_STEP_SUMMARY: join(dir, '..', `${dirName()}-summary.md`),
    GITHUB_OUTPUT: join(dir, '..', `${dirName()}-output.txt`),
    ...extra,
  };
}
const dirName = (): string => basename(dir);
const summary = (): string => {
  try {
    return readFileSync(env()['GITHUB_STEP_SUMMARY']!, 'utf8');
  } catch {
    return '';
  }
};
const outputs = (): string => {
  try {
    return readFileSync(env()['GITHUB_OUTPUT']!, 'utf8');
  } catch {
    return '';
  }
};

function pullRequestEnv(
  base: string,
  extra: Record<string, string> = {},
  headRepo = 'acme/site',
): Record<string, string> {
  const eventPath = join(dir, '..', `${dirName()}-event.json`);
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 7,
        base: { sha: base, repo: { full_name: 'acme/site' } },
        head: { repo: { full_name: headRepo } },
      },
    }),
  );
  return env({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'acme/site',
    'INPUT_GITHUB-TOKEN': 'token',
    ...extra,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'action-run-'));
  lines = [];
  online.mockReset();
});
afterEach(() => {
  for (const suffix of ['summary.md', 'output.txt', 'event.json']) {
    rmSync(join(dir, '..', `${dirName()}-${suffix}`), { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const log = (line: string): void => {
  lines.push(line);
};

describe('a pull request that closes the site', () => {
  it('fails, annotates the line, writes the summary and the outputs', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN, 'public/llms.txt': GOOD_LLMS });
    write('public/robots.txt', 'User-agent: *\nAllow: /blog/\nDisallow: /\n');
    write('public/llms.txt', '<html><body>Not found</body></html>');
    const github = fakeGitHub();
    const code = await run({ env: pullRequestEnv(base), log, fetch: github.fetch });
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith('::error file=public/robots.txt,line=3'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('title=llms-txt-broken'))).toBe(true);
    expect(summary()).toContain('## AI readiness check: failed');
    expect(outputs()).toContain('result=fail');
    expect(outputs()).toMatch(/failures=\d+/);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('updates the same comment when the next push fixes it', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN, 'public/llms.txt': GOOD_LLMS });
    write('public/robots.txt', CLOSED);
    const github = fakeGitHub();
    expect(await run({ env: pullRequestEnv(base), log, fetch: github.fetch })).toBe(1);
    write('public/robots.txt', OPEN);
    expect(await run({ env: pullRequestEnv(base), log, fetch: github.fetch })).toBe(0);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain('## AI readiness check: passed');
    expect(github.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(github.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('passes a change that blocks only a training crawler', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN, 'public/llms.txt': GOOD_LLMS });
    write('public/robots.txt', `${OPEN}\nUser-agent: GPTBot\nDisallow: /\n`);
    const github = fakeGitHub();
    expect(await run({ env: pullRequestEnv(base), log, fetch: github.fetch })).toBe(0);
    expect(github.comments[0]!.body).toContain('training-crawler-change');
    expect(outputs()).toContain('result=pass');
  });

  it('checks the given paths', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    write('public/robots.txt', 'User-agent: *\nDisallow: /pricing\n');
    const github = fakeGitHub();
    const env1 = pullRequestEnv(base, { 'INPUT_CHECK-PATHS': '/pricing\n/blog/' });
    expect(await run({ env: env1, log, fetch: github.fetch })).toBe(1);
    expect(summary()).toContain('at /pricing went from allowed to blocked');
    expect(summary()).not.toContain('at /blog/ went');
  });

  it('keeps the job green when the comment cannot be written (a fork), and says why', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    const github = fakeGitHub([], { postStatus: 403 });
    expect(await run({ env: pullRequestEnv(base), log, fetch: github.fetch })).toBe(0);
    expect(lines.some((line) => line.startsWith('::warning') && line.includes('comment'))).toBe(
      true,
    );
    expect(summary()).toContain('passed');
  });

  it('writes no comment when comment is false', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    const github = fakeGitHub();
    await run({ env: pullRequestEnv(base, { INPUT_COMMENT: 'false' }), log, fetch: github.fetch });
    expect(github.requests).toHaveLength(0);
  });
});

describe('other events and inputs', () => {
  it('judges the files as they are on a push, with no base: a warning, not a failure', async () => {
    repoWith({ 'public/robots.txt': OPEN });
    write('public/robots.txt', 'User-agent: OAI-SearchBot\nDisallow: /\n');
    const code = await run({ env: env({ GITHUB_EVENT_NAME: 'push' }), log });
    expect(code).toBe(0);
    expect(summary()).toContain('no base to compare');
    expect(summary()).toContain('**WARN** `crawler-access-blocked`');
    expect(lines.some((line) => line.startsWith('::warning'))).toBe(true);
  });

  it('fails with no base only when fail-without-base is true', async () => {
    repoWith({ 'public/robots.txt': OPEN });
    write('public/robots.txt', 'User-agent: OAI-SearchBot\nDisallow: /\n');
    const strict = env({ GITHUB_EVENT_NAME: 'push', 'INPUT_FAIL-WITHOUT-BASE': 'true' });
    expect(await run({ env: strict, log })).toBe(1);
    expect(summary()).toContain('**FAIL** `crawler-access-blocked`');
  });

  it('writes no comment and makes no API call for a pull request from a fork', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    write('public/robots.txt', CLOSED);
    const github = fakeGitHub();
    const code = await run({
      env: pullRequestEnv(base, {}, 'someone/site'),
      log,
      fetch: github.fetch,
    });
    expect(code).toBe(1);
    expect(github.requests).toHaveLength(0);
    expect(lines.some((line) => line.startsWith('::warning') && line.includes('fork'))).toBe(true);
    expect(summary()).toContain('failed');
  });

  it('compares with base-ref when it is given', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    write('public/robots.txt', CLOSED);
    git('add', '-A');
    git('commit', '-qm', 'close');
    expect(await run({ env: env({ 'INPUT_BASE-REF': base }), log })).toBe(1);
    expect(await run({ env: env({ 'INPUT_BASE-REF': 'HEAD' }), log })).toBe(0);
  });

  it('refuses pull_request_target and does nothing else', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    const github = fakeGitHub();
    const code = await run({
      env: pullRequestEnv(base, { GITHUB_EVENT_NAME: 'pull_request_target' }),
      log,
      fetch: github.fetch,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('does not run on pull_request_target');
    expect(github.requests).toHaveLength(0);
    expect(summary()).toBe('');
  });

  it('fails with a clear message when the base is not in the checkout', async () => {
    repoWith({ 'public/robots.txt': OPEN });
    const code = await run({ env: pullRequestEnv('a'.repeat(40)), log, fetch: fakeGitHub().fetch });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('fetch-depth: 0');
  });

  it('fails on a wrong input without reading anything', async () => {
    repoWith({ 'public/robots.txt': OPEN });
    expect(await run({ env: env({ 'INPUT_ROBOTS-PATH': '../x' }), log })).toBe(1);
    expect(lines.join('\n')).toContain('robots-path must stay inside the repository');
  });

  it('does not follow a link out of the repository', async (ctx) => {
    repoWith({ 'public/.keep': '' });
    writeFileSync(join(dir, '..', `${dirName()}-secret.txt`), 'secret text');
    try {
      symlinkSync(join(dir, '..', `${dirName()}-secret.txt`), join(dir, 'public/robots.txt'));
    } catch (error) {
      // Windows without developer mode or elevation may not create symbolic links.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        rmSync(join(dir, '..', `${dirName()}-secret.txt`), { force: true });
        ctx.skip();
      }
      throw error;
    }
    const code = await run({ env: env(), log });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('outside the repository');
    expect(summary()).not.toContain('secret text');
    rmSync(join(dir, '..', `${dirName()}-secret.txt`), { force: true });
  });

  it('treats missing files as no robots.txt and no llms.txt', async () => {
    repoWith({ 'README.md': 'hi' });
    expect(await run({ env: env({ GITHUB_EVENT_NAME: 'push' }), log })).toBe(0);
    expect(summary()).toContain('There is no robots.txt at this path');
    expect(summary()).toContain('There is no llms.txt');
  });
});

describe('offline by default', () => {
  it('makes no network call at all: no fetch, no socket, no lookup, no request', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN, 'public/llms.txt': GOOD_LLMS });
    write('public/robots.txt', CLOSED);
    const forbidden = (name: string) => () => {
      throw new Error(`network call: ${name}`);
    };
    vi.stubGlobal('fetch', forbidden('fetch'));
    const spies = [
      vi.spyOn(net, 'connect').mockImplementation(forbidden('net.connect')),
      vi.spyOn(net, 'createConnection').mockImplementation(forbidden('net.createConnection')),
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden('socket.connect')),
      vi.spyOn(tls, 'connect').mockImplementation(forbidden('tls.connect')),
      vi.spyOn(http, 'request').mockImplementation(forbidden('http.request')),
      vi.spyOn(https, 'request').mockImplementation(forbidden('https.request')),
      vi.spyOn(dns, 'lookup').mockImplementation(forbidden('dns.lookup')),
      vi.spyOn(dns, 'resolve').mockImplementation(forbidden('dns.resolve')),
    ];
    // A pull request with the comment turned off, and a push: the two ways to run offline.
    const first = await run({ env: pullRequestEnv(base, { INPUT_COMMENT: 'false' }), log });
    const second = await run({ env: env({ GITHUB_EVENT_NAME: 'push' }), log });
    expect([first, second]).toEqual([1, 0]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(online).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('with the comment on, the only requests are the comment and who the token is, on the GitHub API', async () => {
    const base = repoWith({ 'public/robots.txt': OPEN });
    write('public/robots.txt', CLOSED);
    const github = fakeGitHub();
    await run({ env: pullRequestEnv(base), log, fetch: github.fetch });
    expect(github.requests.length).toBeGreaterThan(0);
    for (const request of github.requests) {
      expect(request.url).toMatch(
        /^https:\/\/api\.github\.com\/(user$|repos\/acme\/site\/issues\/)/,
      );
    }
  });
});

describe('the online check', () => {
  it('runs only when site-url is set, and reports without failing by default', async () => {
    repoWith({ 'public/robots.txt': OPEN });
    online.mockResolvedValue({
      origin: 'https://www.example.com',
      unreadable: null,
      findings: [{ id: 'llms-txt-found', level: 'fail', message: 'There is no llms.txt.' }],
    });
    const code = await run({
      env: env({ GITHUB_EVENT_NAME: 'push', 'INPUT_SITE-URL': 'https://www.example.com' }),
      log,
    });
    expect(online).toHaveBeenCalledWith('https://www.example.com');
    expect(code).toBe(0);
    expect(summary()).toContain('### Online check');
    expect(summary()).toContain('reported only');
  });

  it('fails the job at the level the input names', async () => {
    repoWith({ 'public/robots.txt': OPEN });
    online.mockResolvedValue({
      origin: 'https://www.example.com',
      unreadable: null,
      findings: [{ id: 'llms-txt-found', level: 'fail', message: 'There is no llms.txt.' }],
    });
    const code = await run({
      env: env({
        GITHUB_EVENT_NAME: 'push',
        'INPUT_SITE-URL': 'https://www.example.com',
        'INPUT_SITE-FAIL-ON': 'fail',
      }),
      log,
    });
    expect(code).toBe(1);
  });
});
