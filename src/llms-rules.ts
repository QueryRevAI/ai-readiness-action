import {
  FETCH_LIMITS,
  llmsFindings,
  validateLlmsTxt,
  type LlmsReport,
} from '@queryrev/ai-readiness';
import type { ActionFinding, Level } from './types';

/** The llms.txt in a checkout is judged as the core library judges an answer at /llms.txt. */
export function validateFile(text: string | null): LlmsReport {
  if (text === null) {
    return validateLlmsTxt({ status: 404, contentType: null, body: null, truncated: false });
  }
  const cap = FETCH_LIMITS.llms;
  const truncated = Buffer.byteLength(text, 'utf8') > cap;
  const body = truncated ? Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8') : text;
  return validateLlmsTxt({ status: 200, contentType: 'text/plain', body, truncated });
}

/**
 * Compares the llms.txt after the change with the one before it (null: no file; undefined: no
 * base to compare with).
 *
 * - The file was an llms.txt and no longer is (deleted, or now a page, a robots.txt, or text
 *   without a Markdown H1): `fail`. This is the core library's soft-404 rule, applied to both
 *   sides.
 * - The file is an llms.txt: its structure is reported, and a missing summary or section is a
 *   `warn`.
 * - No llms.txt before or after: `info`. A site is not required to have one.
 * - A file that was not an llms.txt and still is not one: `warn`.
 */
export function compareLlms(
  before: string | null | undefined,
  after: string | null,
  file: string,
): { findings: ActionFinding[]; report: LlmsReport } {
  const head = validateFile(after);
  const base = before === undefined ? null : validateFile(before);
  const findings: ActionFinding[] = [];

  if (base?.present === true && !head.present) {
    const why =
      after === null
        ? 'the file was removed'
        : `the file is no longer an llms.txt (${verdictText(head.verdict)})`;
    findings.push({
      id: 'llms-txt-broken',
      level: 'fail',
      message: `${file} was an llms.txt and now is not: ${why}.`,
      file,
    });
    return { findings, report: head };
  }

  if (after === null) {
    findings.push({
      id: 'llms-txt-absent',
      level: 'info',
      message: `There is no llms.txt at ${file}. A site is not required to have one.`,
    });
    return { findings, report: head };
  }

  if (!head.present) {
    findings.push({
      id: 'llms-txt-not-valid',
      level: 'warn',
      message: `${file} is not an llms.txt (${verdictText(head.verdict)}).`,
      file,
    });
    return { findings, report: head };
  }

  for (const finding of llmsFindings(head)) {
    const level: Level = finding.level === 'fail' ? 'warn' : finding.level;
    findings.push({
      id: finding.id,
      level,
      message: finding.message,
      ...(finding.snippet === undefined ? {} : { snippet: finding.snippet }),
    });
  }
  return { findings, report: head };
}

function verdictText(verdict: LlmsReport['verdict']): string {
  switch (verdict) {
    case 'html':
      return 'an HTML page, which is a soft 404';
    case 'robots':
      return 'a robots.txt';
    case 'no_h1':
      return 'it does not start with a Markdown H1';
    case 'not_text':
      return 'not text';
    case 'not_found':
      return 'not found';
    default:
      return 'not a valid file';
  }
}
