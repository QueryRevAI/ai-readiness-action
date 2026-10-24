/**
 * The findings of an llms.txt validation, drawn from a `LlmsReport`. Used by the command line
 * and by any tool that validates the file: each finding has a stable id, a level and one plain
 * sentence, and nothing is scored.
 */
import { stripUnsafeCharacters } from '../generate';
import type { Finding, FindingLevel } from '../facts/types';
import type { LlmsReport, LlmsVerdict } from './index';

const DOC_URL = 'https://queryrev.com/research/ai-search-readiness#llms-txt-found';

/** The finding ids this module can return. */
export const LLMS_FINDING_IDS: readonly string[] = Object.freeze([
  'llms-txt-found',
  'llms-txt-h1',
  'llms-txt-summary',
  'llms-txt-sections',
  'llms-txt-cut',
]);

export function llmsFinding(
  id: string,
  level: FindingLevel,
  message: string,
  snippet?: string,
): Finding {
  const text = stripUnsafeCharacters(snippet ?? '').slice(0, 300);
  return Object.freeze(
    text === ''
      ? { id, level, message: stripUnsafeCharacters(message), docUrl: DOC_URL }
      : { id, level, message: stripUnsafeCharacters(message), docUrl: DOC_URL, snippet: text },
  );
}

const NOT_AN_LLMS: Readonly<Record<Exclude<LlmsVerdict, 'llms_txt'>, string>> = {
  no_answer: 'No answer arrived, so there is no llms.txt to validate.',
  not_found: 'There is no llms.txt: the address answers 404 or 410.',
  status: 'The address does not answer 200, so it is not an llms.txt.',
  not_text: 'The address answers with a type that is not text, so it is not an llms.txt.',
  html: 'The address answers 200 with an HTML page, which is not an llms.txt (a soft 404).',
  robots: 'The address answers 200 with a robots.txt, which is not an llms.txt.',
  no_h1: 'The text does not start with a Markdown H1 (# Name), which llmstxt.org requires.',
};

/** The findings for one validated answer. */
export function llmsFindings(report: LlmsReport): Finding[] {
  if (report.verdict !== 'llms_txt' || report.structure === null) {
    const message = NOT_AN_LLMS[report.verdict as Exclude<LlmsVerdict, 'llms_txt'>];
    return [
      llmsFinding(
        'llms-txt-found',
        'fail',
        message ?? 'The answer is not an llms.txt.',
        report.status === null ? undefined : `status ${report.status}`,
      ),
    ];
  }
  const structure = report.structure;
  const out: Finding[] = [
    llmsFinding('llms-txt-found', 'pass', 'The file is an llms.txt.', report.h1 ?? undefined),
  ];
  out.push(
    report.h1Count === 1
      ? llmsFinding('llms-txt-h1', 'pass', 'The file has one H1, as llmstxt.org asks.')
      : llmsFinding(
          'llms-txt-h1',
          'warn',
          `The file has ${report.h1Count} H1 headings; llmstxt.org asks for exactly one.`,
        ),
  );
  out.push(
    structure.summary
      ? llmsFinding('llms-txt-summary', 'pass', 'The file has a summary blockquote.')
      : llmsFinding(
          'llms-txt-summary',
          'warn',
          'The file has no summary blockquote (a line starting with ">") before its first section.',
        ),
  );
  out.push(
    structure.sections > 0
      ? llmsFinding(
          'llms-txt-sections',
          'pass',
          `The file has ${structure.sections} H2 section${structure.sections === 1 ? '' : 's'} of links and ${structure.links} link${structure.links === 1 ? '' : 's'} in all.`,
        )
      : llmsFinding('llms-txt-sections', 'warn', 'The file has no H2 section that lists links.'),
  );
  if (report.truncated) {
    out.push(
      llmsFinding(
        'llms-txt-cut',
        'info',
        'The file is larger than 1 MiB; it was read as far as that limit.',
      ),
    );
  }
  return out;
}
