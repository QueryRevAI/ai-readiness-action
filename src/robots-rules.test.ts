import { describe, expect, it } from 'vitest';
import { compareRobots } from './robots-rules';

const OPEN = 'User-agent: *\nAllow: /\n';
const FILE = 'public/robots.txt';

const compare = (before: string | null | undefined, after: string | null, paths: string[] = []) =>
  compareRobots(before, after, paths, FILE);
const levels = (result: ReturnType<typeof compare>, id: string) =>
  result.findings.filter((finding) => finding.id === id);

describe('a change that closes the site', () => {
  it('fails once for the search and user-fetch crawlers that lose the whole site, with the line', () => {
    const result = compare(OPEN, 'User-agent: *\nDisallow: /\n');
    const [fail] = levels(result, 'crawler-access-regression');
    expect(levels(result, 'crawler-access-regression')).toHaveLength(1);
    expect(fail).toMatchObject({ level: 'fail', file: FILE, line: 2, snippet: 'Disallow: /' });
    for (const token of [
      'OAI-SearchBot',
      'ChatGPT-User',
      'PerplexityBot',
      'Perplexity-User',
      'Amazonbot',
    ]) {
      expect(fail?.message).toContain(token);
    }
    expect(fail?.message).toContain('went from allowed to blocked');
    expect(fail?.message).not.toContain('GPTBot,');
  });

  it('reports training crawlers and does not fail for them', () => {
    const result = compare(
      OPEN,
      'User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n',
    );
    expect(result.findings.some((finding) => finding.level === 'fail')).toBe(false);
    expect(result.findings.some((finding) => finding.level === 'warn')).toBe(false);
    const [info] = levels(result, 'training-crawler-change');
    expect(info?.level).toBe('info');
    expect(info?.message).toContain('GPTBot');
    expect(info?.message).toContain("the site's choice");
  });

  it('fails when a crawler for search is blocked by name, not a training one next to it', () => {
    const result = compare(
      OPEN,
      'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n',
    );
    const [fail] = levels(result, 'crawler-access-regression');
    expect(fail?.message).toMatch(/^OAI-SearchBot \(search or user fetch\)/);
    expect(levels(result, 'training-crawler-change')[0]?.message).toContain('GPTBot');
  });

  it('fails when a crawler becomes partial', () => {
    const result = compare(OPEN, 'User-agent: ChatGPT-User\nDisallow: /pricing/\n', ['/pricing/']);
    const fails = levels(result, 'crawler-access-regression');
    expect(fails.map((finding) => finding.message).join('\n')).toContain(
      'ChatGPT-User (search or user fetch) at / went from allowed to partial',
    );
    expect(fails.map((finding) => finding.message).join('\n')).toContain(
      'at /pricing/ went from allowed to blocked',
    );
  });

  it('fails when partial gets worse, and ignores a partial that stays', () => {
    const partial = 'User-agent: OAI-SearchBot\nDisallow: /private/\n';
    expect(levels(compare(partial, partial), 'crawler-access-regression')).toHaveLength(0);
    const worse = compare(partial, 'User-agent: OAI-SearchBot\nDisallow: /\n');
    expect(levels(worse, 'crawler-access-regression')).toHaveLength(1);
  });

  it('checks the given paths and fails for one that gets closed', () => {
    const after = 'User-agent: *\nDisallow: /blog/\n';
    const result = compare(OPEN, after, ['/blog/post', '/pricing']);
    const fails = levels(result, 'crawler-access-regression');
    expect(fails).toHaveLength(1);
    expect(fails[0]?.message).toContain('at /blog/post went from allowed to blocked');
    expect(fails[0]).toMatchObject({ line: 2, snippet: 'Disallow: /blog/' });
  });
});

describe('a change that does not close anything', () => {
  it('passes when the file is unchanged', () => {
    const result = compare(OPEN, OPEN);
    expect(result.findings).toEqual([
      expect.objectContaining({ id: 'crawler-access', level: 'pass' }),
    ]);
  });

  it('passes when a block is lifted', () => {
    const result = compare('User-agent: *\nDisallow: /\n', OPEN);
    expect(result.findings.some((finding) => finding.level === 'fail')).toBe(false);
    expect(result.rows.every((row) => row.after === 'allowed' && !row.worse)).toBe(true);
  });

  it('says a block that was already there is not new', () => {
    const closed = 'User-agent: *\nDisallow: /\n';
    const result = compare(closed, closed);
    expect(result.findings.some((finding) => finding.level === 'fail')).toBe(false);
    expect(levels(result, 'crawler-access-unchanged')[0]?.message).toContain('as it was before');
  });

  it('treats housekeeping rules under * as open for AI crawlers', () => {
    const after = 'User-agent: *\nDisallow: /cart\nDisallow: /search\n';
    expect(compare(OPEN, after).findings.some((finding) => finding.level === 'fail')).toBe(false);
  });

  it('treats a file that did not exist before as open, and a deleted file as open', () => {
    expect(
      compare(null, 'User-agent: *\nDisallow: /\n').findings.some(
        (finding) => finding.id === 'crawler-access-regression',
      ),
    ).toBe(true);
    expect(compare(OPEN, null).findings.some((finding) => finding.level === 'fail')).toBe(false);
  });

  it('keeps the rows: every crawler at "/" and only closed rows for other paths', () => {
    const result = compare(OPEN, 'User-agent: *\nDisallow: /blog/\n', ['/blog/', '/pricing']);
    expect(result.rows.filter((row) => row.path === '/')).toHaveLength(11);
    expect(result.rows.filter((row) => row.path === '/pricing')).toHaveLength(11);
    expect(
      result.rows.filter((row) => row.path === '/blog/' && row.after === 'blocked'),
    ).toHaveLength(11);
  });
});

describe('without a base to compare with', () => {
  it('warns about a blocked or partial search crawler: nothing got worse', () => {
    const blocked = compare(undefined, 'User-agent: PerplexityBot\nDisallow: /\n');
    expect(levels(blocked, 'crawler-access-blocked')[0]?.level).toBe('warn');
    expect(blocked.findings.some((finding) => finding.level === 'fail')).toBe(false);
    expect(blocked.rows.every((row) => row.before === null)).toBe(true);
    const partial = compare(undefined, 'User-agent: PerplexityBot\nDisallow: /guides/\n');
    expect(levels(partial, 'crawler-access-partial')[0]?.level).toBe('warn');
    expect(partial.findings.some((finding) => finding.level === 'fail')).toBe(false);
  });

  it('fails for a blocked one, and warns for a partial one, in strict mode', () => {
    const strict = { failWithoutBase: true };
    const blocked = compareRobots(
      undefined,
      'User-agent: PerplexityBot\nDisallow: /\n',
      [],
      FILE,
      strict,
    );
    expect(levels(blocked, 'crawler-access-blocked')[0]?.level).toBe('fail');
    const partial = compareRobots(
      undefined,
      'User-agent: PerplexityBot\nDisallow: /guides/\n',
      [],
      FILE,
      strict,
    );
    expect(levels(partial, 'crawler-access-partial')[0]?.level).toBe('warn');
  });

  it('passes an open file and a missing one', () => {
    expect(compare(undefined, OPEN).findings[0]?.level).toBe('pass');
    expect(compare(undefined, null).findings[0]?.level).toBe('pass');
  });

  it('does not fail for a blocked training crawler, even in strict mode', () => {
    const result = compareRobots(undefined, 'User-agent: GPTBot\nDisallow: /\n', [], FILE, {
      failWithoutBase: true,
    });
    expect(result.findings.some((finding) => finding.level === 'fail')).toBe(false);
  });
});
