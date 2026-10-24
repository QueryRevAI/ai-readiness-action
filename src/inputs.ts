import { isAbsolute, normalize, posix, win32 } from 'node:path';

/** A wrong or unsafe input. The message names the input; the job fails with exit code 1. */
export class InputError extends Error {
  override readonly name = 'InputError';
}

export type SiteFailOn = 'never' | 'warn' | 'fail';

export interface ActionInputs {
  readonly robotsPath: string;
  readonly llmsPath: string;
  /** URL paths to test besides "/", validated. */
  readonly checkPaths: readonly string[];
  /** Null: use the pull request's base commit when there is one. */
  readonly baseRef: string | null;
  /** Without a base, a blocked crawler fails the job instead of being a warning. */
  readonly failWithoutBase: boolean;
  readonly comment: boolean;
  /** Null when the input is empty. */
  readonly token: string | null;
  readonly siteUrl: string | null;
  readonly siteFailOn: SiteFailOn;
}

const MAX_PATH_LENGTH = 300;
export const MAX_CHECK_PATHS = 25;
const MAX_CHECK_PATH_LENGTH = 300;

/** An input as GitHub passes it: `INPUT_` and the upper-cased name, spaces as underscores. */
function raw(env: Readonly<Record<string, string | undefined>>, name: string): string {
  return (env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
}

// Control characters, including line breaks and NUL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A path in the checkout: relative, inside the repository, no NUL or other control character.
 * Returned with forward slashes and without `./`.
 */
export function checkoutPath(name: string, value: string): string {
  if (value === '') throw new InputError(`${name} must not be empty.`);
  if (value.length > MAX_PATH_LENGTH) {
    throw new InputError(`${name} is longer than ${MAX_PATH_LENGTH} characters.`);
  }
  if (CONTROL.test(value)) throw new InputError(`${name} holds a control character.`);
  const slashes = value.replaceAll('\\', '/');
  if (isAbsolute(value) || win32.isAbsolute(value) || slashes.startsWith('/')) {
    throw new InputError(`${name} must be a path relative to the repository root.`);
  }
  const clean = posix.normalize(slashes);
  if (clean === '..' || clean.startsWith('../') || normalize(clean).startsWith('..')) {
    throw new InputError(`${name} must stay inside the repository.`);
  }
  if (clean === '.' || clean.endsWith('/')) {
    throw new InputError(`${name} must name a file.`);
  }
  return clean;
}

/** URL paths: one per line or comma separated, each starting with one "/". */
export function urlPaths(value: string): string[] {
  const found: string[] = [];
  for (const entry of value.split(/[\n,]/)) {
    const path = entry.trim();
    if (path === '') continue;
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new InputError(`check-paths: "${path.slice(0, 40)}" must start with one "/".`);
    }
    if (path.length > MAX_CHECK_PATH_LENGTH || CONTROL.test(path) || /\s/.test(path)) {
      throw new InputError(
        `check-paths: a path is longer than ${MAX_CHECK_PATH_LENGTH} characters or holds a space or control character.`,
      );
    }
    if (path !== '/' && !found.includes(path)) found.push(path);
  }
  if (found.length > MAX_CHECK_PATHS) {
    throw new InputError(`check-paths takes at most ${MAX_CHECK_PATHS} paths.`);
  }
  return found;
}

/** A git ref: letters, digits and `._/-^~@{}`, not starting with "-" (which git reads as an option). */
export function gitRef(value: string): string {
  if (
    value.length > 200 ||
    !/^[A-Za-z0-9._/@^~{}-]+$/.test(value) ||
    value.startsWith('-') ||
    value.includes('..')
  ) {
    throw new InputError('base-ref is not a commit, branch or tag name.');
  }
  return value;
}

function flag(name: string, value: string, fallback: boolean): boolean {
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InputError(`${name} must be "true" or "false".`);
}

export function readInputs(env: Readonly<Record<string, string | undefined>>): ActionInputs {
  const siteUrl = raw(env, 'site-url');
  if (siteUrl !== '') {
    let url: URL;
    try {
      url = new URL(siteUrl);
    } catch {
      throw new InputError('site-url must be an address such as https://www.example.com.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new InputError('site-url must start with https:// or http://.');
    }
  }
  const siteFailOn = raw(env, 'site-fail-on') || 'never';
  if (siteFailOn !== 'never' && siteFailOn !== 'warn' && siteFailOn !== 'fail') {
    throw new InputError('site-fail-on must be "never", "warn" or "fail".');
  }
  const baseRef = raw(env, 'base-ref');
  return Object.freeze({
    robotsPath: checkoutPath('robots-path', raw(env, 'robots-path') || 'public/robots.txt'),
    llmsPath: checkoutPath('llms-path', raw(env, 'llms-path') || 'public/llms.txt'),
    checkPaths: Object.freeze(urlPaths(raw(env, 'check-paths'))),
    baseRef: baseRef === '' ? null : gitRef(baseRef),
    failWithoutBase: flag('fail-without-base', raw(env, 'fail-without-base'), false),
    comment: flag('comment', raw(env, 'comment'), true),
    token: raw(env, 'github-token') || null,
    siteUrl: siteUrl === '' ? null : siteUrl,
    siteFailOn,
  });
}
