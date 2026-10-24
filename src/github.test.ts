import { describe, expect, it } from 'vitest';
import {
  annotation,
  COMMENT_LIMIT,
  COMMENT_MARKER,
  pullRequestFrom,
  upsertComment,
  type PullRequestContext,
} from './github';
import { fakeGitHub, withMarker } from './github.testkit';

const pull: PullRequestContext = {
  apiUrl: 'https://api.github.com',
  repository: 'acme/site',
  number: 7,
  fork: false,
};

describe('the one comment', () => {
  it('creates a comment that starts with the marker', async () => {
    const api = fakeGitHub();
    const result = await upsertComment(pull, 'report', { token: 't', fetch: api.fetch });
    expect(result.outcome).toBe('created');
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]?.body.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
  });

  it('updates its own comment on the next run and writes no second one', async () => {
    const api = fakeGitHub();
    await upsertComment(pull, 'first', { token: 't', fetch: api.fetch });
    const second = await upsertComment(pull, 'second', { token: 't', fetch: api.fetch });
    expect(second.outcome).toBe('updated');
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]?.body).toContain('second');
    expect(api.comments[0]?.body).not.toContain('first');
  });

  it('leaves other comments alone and finds its own among many pages', async () => {
    const others = Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      body: `comment ${index}`,
      user: { login: 'someone', type: 'User' as const },
    }));
    const mine = {
      id: 500,
      body: withMarker('old'),
      user: { login: 'github-actions[bot]', type: 'Bot' as const },
    };
    const api = fakeGitHub([...others, mine]);
    const result = await upsertComment(pull, 'new', { token: 't', fetch: api.fetch });
    expect(result).toEqual({ outcome: 'updated', id: 500 });
    expect(api.comments.filter((comment) => comment.body.includes(COMMENT_MARKER))).toHaveLength(1);
    expect(api.comments).toHaveLength(131);
  });

  it('does not take a comment that only mentions the marker', async () => {
    const quoted = {
      id: 5,
      body: `see ${COMMENT_MARKER}`,
      user: { login: 'someone', type: 'User' as const },
    };
    const api = fakeGitHub([quoted]);
    const result = await upsertComment(pull, 'x', { token: 't', fetch: api.fetch });
    expect(result.outcome).toBe('created');
    expect(quoted.body).toBe(`see ${COMMENT_MARKER}`);
  });

  it('never updates a comment of another author that carries the marker, and writes its own', async () => {
    const forged = {
      id: 1,
      body: withMarker('forged'),
      user: { login: 'mallory', type: 'User' as const },
    };
    const api = fakeGitHub([forged]);
    const result = await upsertComment(pull, 'x', { token: 't', fetch: api.fetch });
    expect(result.outcome).toBe('created');
    expect(forged.body).toBe(withMarker('forged'));
    expect(api.requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
    expect(api.comments).toHaveLength(2);
    expect(api.comments[1]?.user).toEqual({ login: 'github-actions[bot]', type: 'Bot' });
    // The next run updates the bot's comment, not the forged one.
    const again = await upsertComment(pull, 'y', { token: 't', fetch: api.fetch });
    expect(again).toEqual({ outcome: 'updated', id: api.comments[1]!.id });
    expect(forged.body).toBe(withMarker('forged'));
  });

  it('does not take a comment of another bot', async () => {
    const other = {
      id: 1,
      body: withMarker('other'),
      user: { login: 'some-app[bot]', type: 'Bot' as const },
    };
    const api = fakeGitHub([other]);
    expect((await upsertComment(pull, 'x', { token: 't', fetch: api.fetch })).outcome).toBe(
      'created',
    );
    expect(other.body).toBe(withMarker('other'));
  });

  it('with a token of its own, updates the comments of that login and no one else', async () => {
    const forged = {
      id: 1,
      body: withMarker('forged'),
      user: { login: 'mallory', type: 'User' as const },
    };
    const mine = {
      id: 2,
      body: withMarker('mine'),
      user: { login: 'Release-Bot-User', type: 'User' as const },
    };
    const api = fakeGitHub([forged, mine], { me: { login: 'release-bot-user', type: 'User' } });
    expect(await upsertComment(pull, 'x', { token: 't', fetch: api.fetch })).toEqual({
      outcome: 'updated',
      id: 2,
    });
    expect(forged.body).toBe(withMarker('forged'));
  });

  it('reports an update GitHub refuses on its own comment, without writing a second one', async () => {
    const mine = {
      id: 2,
      body: withMarker('mine'),
      user: { login: 'github-actions[bot]', type: 'Bot' as const },
    };
    const api = fakeGitHub([mine], { patchStatusFor: { 2: 403 } });
    const result = await upsertComment(pull, 'x', { token: 't', fetch: api.fetch });
    expect(result.outcome).toBe('skipped');
    expect(api.comments).toHaveLength(1);
  });

  it('makes no request at all for a pull request from a fork', async () => {
    const api = fakeGitHub();
    const result = await upsertComment({ ...pull, fork: true }, 'x', {
      token: 't',
      fetch: api.fetch,
    });
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect((result as { reason: string }).reason).toContain('fork');
    expect(api.requests).toHaveLength(0);
  });

  it('cuts a body over the size limit', async () => {
    const api = fakeGitHub();
    await upsertComment(pull, 'x'.repeat(100_000), { token: 't', fetch: api.fetch });
    expect(api.comments[0]!.body.length).toBeLessThanOrEqual(COMMENT_LIMIT);
  });

  it('sends the token only to the GitHub API address, as a bearer token, and refuses redirects', async () => {
    const api = fakeGitHub();
    await upsertComment(pull, 'x', { token: 'secret-token', fetch: api.fetch });
    for (const request of api.requests) {
      expect(
        request.url === 'https://api.github.com/user' ||
          request.url.startsWith('https://api.github.com/repos/acme/site/issues'),
      ).toBe(true);
      expect(request.headers['Authorization']).toBe('Bearer secret-token');
    }
  });

  it('returns a reason, and does not throw, when GitHub refuses the new comment', async () => {
    const api = fakeGitHub([], { postStatus: 403 });
    const result = await upsertComment(pull, 'x', { token: 't', fetch: api.fetch });
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect((result as { reason: string }).reason).toContain('cannot write comments');
  });

  it('returns a reason when the network fails, without the error text', async () => {
    const result = await upsertComment(pull, 'x', {
      token: 'secret-token',
      fetch: () => Promise.reject(new TypeError('secret-token leaked in message')),
    });
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('refuses a GitHub API address that is not https', async () => {
    const api = fakeGitHub();
    const result = await upsertComment({ ...pull, apiUrl: 'http://evil.example' }, 'x', {
      token: 't',
      fetch: api.fetch,
    });
    expect(result.outcome).toBe('skipped');
    expect(api.requests).toHaveLength(0);
  });
});

describe('the pull request from the environment', () => {
  const event = { pull_request: { number: 12 } };
  it('is read for the pull_request event only', () => {
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/site' };
    expect(pullRequestFrom(env, event)).toEqual({
      apiUrl: 'https://api.github.com',
      repository: 'acme/site',
      number: 12,
      fork: true,
    });
    expect(pullRequestFrom({ ...env, GITHUB_EVENT_NAME: 'push' }, event)).toBeNull();
    expect(pullRequestFrom({ ...env, GITHUB_EVENT_NAME: 'pull_request_target' }, event)).toBeNull();
  });

  it('knows a fork from the head and base repositories of the event', () => {
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/site' };
    const same = {
      pull_request: {
        number: 3,
        head: { repo: { full_name: 'acme/site' } },
        base: { repo: { full_name: 'acme/site' } },
      },
    };
    expect(pullRequestFrom(env, same)?.fork).toBe(false);
    const fork = {
      pull_request: { ...same.pull_request, head: { repo: { full_name: 'someone/site' } } },
    };
    expect(pullRequestFrom(env, fork)?.fork).toBe(true);
    const deleted = { pull_request: { ...same.pull_request, head: { repo: null } } };
    expect(pullRequestFrom(env, deleted)?.fork).toBe(true);
  });

  it('is null for a repository name or number that is not valid', () => {
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/site/../x' };
    expect(pullRequestFrom(env, event)).toBeNull();
    expect(
      pullRequestFrom(
        { ...env, GITHUB_REPOSITORY: 'acme/site' },
        { pull_request: { number: '12' } },
      ),
    ).toBeNull();
    expect(pullRequestFrom({ ...env, GITHUB_REPOSITORY: 'acme/site' }, null)).toBeNull();
  });
});

describe('workflow commands', () => {
  it('escapes text so a line of a file cannot start another command', () => {
    const line = annotation(
      'error',
      { message: '50% done\n::set-output name=x::y', file: 'a,b:c.txt', line: 3 },
      'id',
    );
    expect(line).toBe(
      '::error file=a%2Cb%3Ac.txt,line=3,title=id::50%25 done%0A::set-output name=x::y',
    );
    expect(line.split('\n')).toHaveLength(1);
  });
});
