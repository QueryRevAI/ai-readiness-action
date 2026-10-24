import { describe, expect, it } from 'vitest';
import { checkoutPath, gitRef, InputError, readInputs, urlPaths } from './inputs';

const inputs = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]),
  );

describe('defaults', () => {
  it('reads the documented defaults from an empty environment', () => {
    expect(readInputs({})).toEqual({
      robotsPath: 'public/robots.txt',
      llmsPath: 'public/llms.txt',
      checkPaths: [],
      baseRef: null,
      failWithoutBase: false,
      comment: true,
      token: null,
      siteUrl: null,
      siteFailOn: 'never',
    });
  });

  it('reads values and trims them', () => {
    const read = readInputs(
      inputs({
        'robots-path': ' ./static/robots.txt ',
        'llms-path': 'site\\llms.txt',
        'check-paths': '/blog/\n/pricing, /guides/a?x=1\n\n/blog/',
        'base-ref': 'origin/main',
        'fail-without-base': 'true',
        comment: 'false',
        'github-token': ' tok ',
        'site-url': 'https://www.example.com',
        'site-fail-on': 'warn',
      }),
    );
    expect(read).toMatchObject({
      robotsPath: 'static/robots.txt',
      llmsPath: 'site/llms.txt',
      checkPaths: ['/blog/', '/pricing', '/guides/a?x=1'],
      baseRef: 'origin/main',
      failWithoutBase: true,
      comment: false,
      token: 'tok',
      siteUrl: 'https://www.example.com',
      siteFailOn: 'warn',
    });
  });
});

describe('paths in the checkout', () => {
  it.each([
    ['', 'must not be empty'],
    ['/etc/passwd', 'relative'],
    ['C:\\Windows\\robots.txt', 'relative'],
    ['../robots.txt', 'inside the repository'],
    ['public/../../robots.txt', 'inside the repository'],
    ['public/', 'name a file'],
    ['.', 'name a file'],
    ['public/robots.txt\u0000.png', 'control character'],
    ['public/robots.txt\nx', 'control character'],
    ['a'.repeat(301), 'longer than'],
  ])('refuses %j', (value, why) => {
    expect(() => checkoutPath('robots-path', value)).toThrow(InputError);
    expect(() => checkoutPath('robots-path', value)).toThrow(why);
  });

  it('accepts a nested path and normalises it', () => {
    expect(checkoutPath('x', 'a/./b//robots.txt')).toBe('a/b/robots.txt');
  });
});

describe('URL paths', () => {
  it.each(['blog', '//evil.example/x', '/a b', '/a\u0000', `/${'a'.repeat(300)}`])(
    'refuses %j',
    (value) => {
      expect(() => urlPaths(value)).toThrow(InputError);
    },
  );

  it('takes at most 25', () => {
    const many = Array.from({ length: 26 }, (_, index) => `/p${index}`).join('\n');
    expect(() => urlPaths(many)).toThrow('at most 25');
    expect(urlPaths('/')).toEqual([]);
  });
});

describe('refs and flags', () => {
  it.each(['--upload-pack=x', '-n', 'a..b', 'main; rm -rf', 'a b', '', 'x'.repeat(201)])(
    'refuses the ref %j',
    (value) => {
      expect(() => gitRef(value)).toThrow(InputError);
    },
  );

  it('accepts refs and shas', () => {
    expect(gitRef('origin/main')).toBe('origin/main');
    expect(gitRef('HEAD^1')).toBe('HEAD^1');
    expect(gitRef('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('refuses a comment value that is not true or false', () => {
    expect(() => readInputs(inputs({ comment: 'yes' }))).toThrow('"true" or "false"');
    expect(() => readInputs(inputs({ 'fail-without-base': '1' }))).toThrow('fail-without-base');
  });

  it('refuses a bad site-url and a bad site-fail-on', () => {
    expect(() => readInputs(inputs({ 'site-url': 'www.example.com' }))).toThrow('site-url');
    expect(() => readInputs(inputs({ 'site-url': 'file:///etc/passwd' }))).toThrow('https://');
    expect(() => readInputs(inputs({ 'site-fail-on': 'always' }))).toThrow('site-fail-on');
  });
});
