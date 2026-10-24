import { execFile } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FETCH_LIMITS, ROBOTS_MAX_BYTES } from '@queryrev/ai-readiness';
import { InputError } from './inputs';

const run = promisify(execFile);

/** The most that is read of each file: the core library's caps for a robots.txt and an llms.txt. */
export const LIMITS = { robots: ROBOTS_MAX_BYTES, llms: FETCH_LIMITS.llms } as const;
export type FileKind = keyof typeof LIMITS;

/**
 * Reads a text file of the checkout. Null when there is no file. The path must resolve, after
 * symbolic links, to a regular file inside the workspace: a pull request can add a link that
 * points elsewhere on the runner, and what it points at must not reach a comment.
 */
export async function readCheckoutFile(
  workspace: string,
  path: string,
  kind: FileKind,
): Promise<string | null> {
  const limit = LIMITS[kind];
  const root = await realpath(workspace);
  const wanted = resolve(root, path);
  let real: string;
  try {
    real = await realpath(wanted);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const inside = relative(root, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new InputError(`${path} resolves to a file outside the repository.`);
  }
  if (!(await stat(real)).isFile()) throw new InputError(`${path} is not a regular file.`);
  const handle = await open(real, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) {
      throw new InputError(`${path} is larger than ${limit / 1024} KiB.`);
    }
    return new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function git(
  cwd: string,
  args: string[],
  limit: number = LIMITS.llms,
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: limit + 1024,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new InputError('A file at the base is larger than the limit.');
    }
    if (failure.code === 'ENOENT') throw new InputError('git is not installed on this runner.');
    return { stdout: '', code: typeof failure.code === 'number' ? failure.code : 1 };
  }
}

/** Whether the base ref names a commit that the checkout has. */
export async function baseExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
}

/**
 * The file as it was at the base: null when the base has no such file. Reads the committed
 * blob; no network call is made, so the base commit has to be in the checkout.
 */
export async function readAtRef(
  cwd: string,
  ref: string,
  path: string,
  kind: FileKind,
): Promise<string | null> {
  const spec = `${ref}:${path}`;
  const type = await git(cwd, ['cat-file', '-t', spec]);
  if (type.code !== 0) return null;
  if (type.stdout.trim() !== 'blob') return null;
  const blob = await git(cwd, ['cat-file', 'blob', spec], LIMITS[kind]);
  if (blob.code !== 0) return null;
  return blob.stdout;
}
