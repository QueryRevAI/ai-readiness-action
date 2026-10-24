import { crawlersCoveredLine } from '@queryrev/ai-readiness';
import { COMMENT_MARKER } from './github';
import { cell, code, oneLine } from './text';
import type { AccessRow, ActionFinding, Level } from './types';

export interface Report {
  /** What the files were compared with, for the line under the heading; null: no base. */
  readonly base: string | null;
  readonly robots: {
    readonly file: string;
    readonly found: boolean;
    readonly rows: readonly AccessRow[];
    readonly findings: readonly ActionFinding[];
  };
  readonly llms: {
    readonly file: string;
    readonly found: boolean;
    readonly findings: readonly ActionFinding[];
  };
  readonly online: null | {
    readonly origin: string;
    readonly findings: readonly ActionFinding[];
    readonly unreadable: string | null;
    readonly failOn: 'never' | 'warn' | 'fail';
  };
}

const LABEL: Readonly<Record<Level, string>> = {
  fail: 'FAIL',
  warn: 'WARN',
  info: 'INFO',
  pass: 'PASS',
};

/** The findings that fail the job: those of the files, and the online ones the input says count. */
export function failingFindings(report: Report): ActionFinding[] {
  const failing = [...report.robots.findings, ...report.llms.findings].filter(
    (finding) => finding.level === 'fail',
  );
  if (report.online !== null && report.online.failOn !== 'never') {
    const counts = (level: Level) =>
      level === 'fail' || (report.online!.failOn === 'warn' && level === 'warn');
    failing.push(...report.online.findings.filter((finding) => counts(finding.level)));
  }
  return failing;
}

function count(findings: readonly ActionFinding[], level: Level): number {
  return findings.filter((finding) => finding.level === level).length;
}

function bullet(finding: ActionFinding): string {
  const where =
    finding.file !== undefined && finding.line !== undefined
      ? ` (${code(finding.file)} line ${finding.line})`
      : '';
  const evidence = finding.snippet === undefined ? '' : `: ${code(finding.snippet)}`;
  return `- **${LABEL[finding.level]}** ${code(finding.id)} ${oneLine(finding.message, 400)}${where}${evidence}`;
}

/** A commit SHA is shown short; a branch or tag name as it is. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 10) : ref;
}

/** The findings that are not listed under "What fails". */
function otherBullets(findings: readonly ActionFinding[]): string[] {
  const rest = findings.filter((finding) => finding.level !== 'fail');
  return rest.length === 0 ? ['No other findings.'] : rest.map(bullet);
}

function accessTable(rows: readonly AccessRow[]): string {
  // The home page for every crawler; other paths only where something is closed or got worse.
  const shown = rows.filter((row) => row.path === '/' || row.after !== 'allowed' || row.worse);
  const lines = [
    '| Crawler | Purpose | Path | Before | After |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of shown) {
    const before = row.before ?? 'no base';
    const after = row.worse ? `${row.after} (worse)` : row.after;
    lines.push(
      `| ${row.token} | ${row.purpose === 'user' ? 'user fetch' : row.purpose} | ${cell(row.path)} | ${before} | ${after} |`,
    );
  }
  return lines.join('\n');
}

/**
 * The report as Markdown, for the job summary and the pull request comment. A result and
 * its findings, each with its evidence; nothing is graded.
 */
export function renderReport(report: Report, options: { marker: boolean }): string {
  const failing = failingFindings(report);
  const all = [...report.robots.findings, ...report.llms.findings];
  const out: string[] = [];
  if (options.marker) out.push(COMMENT_MARKER);
  out.push(`## AI readiness check: ${failing.length === 0 ? 'passed' : 'failed'}`, '');
  out.push(
    `${failing.length} failing, ${count(all, 'warn')} warnings. ` +
      (report.base === null
        ? 'There was no base to compare with, so the files are judged as they are.'
        : `Compared with ${code(shortRef(report.base))}.`),
    '',
  );

  if (failing.length > 0) {
    out.push('### What fails', '', ...failing.map(bullet), '');
  }

  out.push(`### robots.txt (${code(report.robots.file)})`, '');
  if (!report.robots.found) {
    out.push('There is no robots.txt at this path, which allows every crawler.', '');
  }
  out.push(
    ...otherBullets(report.robots.findings),
    '',
    accessTable(report.robots.rows),
    '',
    "Training crawlers are reported and never fail the check: blocking them is the site's choice.",
    '',
  );

  out.push(`### llms.txt (${code(report.llms.file)})`, '');
  out.push(...report.llms.findings.filter((finding) => finding.level !== 'fail').map(bullet), '');

  if (report.online !== null) {
    out.push(`### Online check (${code(report.online.origin)})`, '');
    if (report.online.unreadable !== null) {
      out.push(`The site could not be read: ${oneLine(report.online.unreadable, 200)}.`, '');
    }
    out.push(
      ...report.online.findings.filter((finding) => finding.level !== 'pass').map(bullet),
      '',
      report.online.failOn === 'never'
        ? 'The online check is reported only; it does not fail the job.'
        : `The online check fails the job at level ${report.online.failOn}.`,
      '',
    );
  }

  out.push(
    '---',
    crawlersCoveredLine(),
    'The check reads files. It cannot see a CDN or firewall rule that answers crawlers differently from robots.txt, or what a crawler fetches.',
  );
  return `${out.join('\n')}\n`;
}
