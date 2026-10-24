import { readFile } from 'node:fs/promises';
import { baseExists, readAtRef, readCheckoutFile } from './files';
import {
  annotation,
  pullRequestFrom,
  setOutput,
  upsertComment,
  writeSummary,
  type Env,
} from './github';
import { InputError, gitRef, readInputs, type ActionInputs } from './inputs';
import { compareLlms } from './llms-rules';
import { failingFindings, renderReport, type Report } from './report';
import { compareRobots } from './robots-rules';
import { oneLine, escapeData } from './text';

export interface RunOptions {
  readonly env: Env;
  /** Where the checkout is when GITHUB_WORKSPACE is not set. */
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  /** For tests: the function the comment is written with. */
  readonly fetch?: typeof fetch;
}

const MAX_ANNOTATIONS = 10;

async function readEvent(env: Env): Promise<unknown> {
  const path = env['GITHUB_EVENT_PATH'];
  if (path === undefined || path === '') return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The base to compare with: the input, else the pull request's base commit, else none. */
function baseFor(inputs: ActionInputs, event: unknown, env: Env): string | null {
  if (inputs.baseRef !== null) return inputs.baseRef;
  if (env['GITHUB_EVENT_NAME'] !== 'pull_request') return null;
  const sha = (event as { pull_request?: { base?: { sha?: unknown } } } | null)?.pull_request?.base
    ?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40,64}$/.test(sha) ? gitRef(sha) : null;
}

/**
 * Runs the check and returns the exit code: 0 when nothing fails, 1 when a finding fails or an
 * input is wrong. Offline unless `site-url` is set; the one other network call is the pull
 * request comment.
 */
export async function run(options: RunOptions): Promise<number> {
  const { env } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    // A workflow on pull_request_target runs with a write token and secrets while it reads
    // files that a stranger changed. This Action refuses to run there.
    if (env['GITHUB_EVENT_NAME'] === 'pull_request_target') {
      throw new InputError(
        'This Action does not run on pull_request_target. Use the pull_request event.',
      );
    }
    const inputs = readInputs(env);
    const workspace = env['GITHUB_WORKSPACE'] || options.cwd || process.cwd();
    const event = await readEvent(env);
    const baseRef = baseFor(inputs, event, env);

    let robotsBefore: string | null | undefined;
    let llmsBefore: string | null | undefined;
    if (baseRef !== null) {
      if (!(await baseExists(workspace, baseRef))) {
        throw new InputError(
          `The base ${baseRef} is not in the checkout. Check out with actions/checkout and fetch-depth: 0, or set base-ref to a commit that is there.`,
        );
      }
      robotsBefore = await readAtRef(workspace, baseRef, inputs.robotsPath, 'robots');
      llmsBefore = await readAtRef(workspace, baseRef, inputs.llmsPath, 'llms');
    }
    const robotsAfter = await readCheckoutFile(workspace, inputs.robotsPath, 'robots');
    const llmsAfter = await readCheckoutFile(workspace, inputs.llmsPath, 'llms');

    const robots = compareRobots(robotsBefore, robotsAfter, inputs.checkPaths, inputs.robotsPath, {
      failWithoutBase: inputs.failWithoutBase,
    });
    const llms = compareLlms(llmsBefore, llmsAfter, inputs.llmsPath);

    let online: Report['online'] = null;
    if (inputs.siteUrl !== null) {
      const { runOnlineCheck } = await import('./online');
      const result = await runOnlineCheck(inputs.siteUrl);
      online = { ...result, failOn: inputs.siteFailOn };
    }

    const report: Report = {
      base: baseRef,
      robots: {
        file: inputs.robotsPath,
        found: robotsAfter !== null,
        rows: robots.rows,
        findings: robots.findings,
      },
      llms: { file: inputs.llmsPath, found: llmsAfter !== null, findings: llms.findings },
      online,
    };
    const failing = failingFindings(report);

    await writeSummary(env, renderReport(report, { marker: false }));
    await setOutput(env, 'result', failing.length === 0 ? 'pass' : 'fail');
    await setOutput(env, 'failures', String(failing.length));

    let annotated = 0;
    for (const finding of failing) {
      if (annotated++ >= MAX_ANNOTATIONS) break;
      log(annotation('error', { ...finding, message: oneLine(finding.message, 400) }, finding.id));
    }
    const warned = [...robots.findings, ...llms.findings].filter(
      (finding) => finding.level === 'warn',
    );
    for (const finding of warned.slice(0, MAX_ANNOTATIONS)) {
      log(
        annotation('warning', { ...finding, message: oneLine(finding.message, 400) }, finding.id),
      );
    }
    if (online?.unreadable) {
      log(
        annotation(
          'warning',
          { message: `The online check could not read the site: ${oneLine(online.unreadable)}.` },
          'online-check',
        ),
      );
    }

    const pull = pullRequestFrom(env, event);
    if (inputs.comment && pull !== null && inputs.token !== null) {
      const result = await upsertComment(pull, renderReport(report, { marker: true }), {
        token: inputs.token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (result.outcome === 'skipped') {
        log(
          annotation(
            'warning',
            {
              message: `The pull request comment was not written: ${result.reason}. The report is in the job summary.`,
            },
            'comment',
          ),
        );
      }
    }

    log(
      failing.length === 0
        ? 'AI readiness check passed.'
        : `AI readiness check failed: ${failing.length} finding${failing.length === 1 ? '' : 's'} at fail level.`,
    );
    return failing.length === 0 ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof InputError
        ? error.message
        : `The check stopped on an unexpected error (${error instanceof Error ? error.name : 'error'}).`;
    log(`::error title=ai-readiness::${escapeData(message)}`);
    try {
      await setOutput(env, 'result', 'fail');
    } catch {
      // The output file is not available; the exit code is the answer.
    }
    return 1;
  }
}
