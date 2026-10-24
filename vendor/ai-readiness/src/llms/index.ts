/** llms.txt checks: telling the file from a page, and its structure (llmstxt.org). */

/** A byte order mark at the start of a text. */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Whether a body is an HTML document (a site that answers every address with a page). */
export function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return true;
  const start = body.replace(BOM, '').trimStart().slice(0, 200).toLowerCase();
  return (
    start.startsWith('<!doctype html') || start.startsWith('<html') || start.startsWith('<head')
  );
}

/**
 * A robots.txt served at another address (a site that answers every path with it): a
 * `User-agent` line and no Markdown link. It is not an llms.txt, whatever its first line.
 */
export function looksLikeRobotsTxt(body: string): boolean {
  return /^[ \t]*user-agent[ \t]*:/im.test(body) && llmsStructure(body).links === 0;
}

/**
 * The structure of an llms.txt, as llmstxt.org describes the file: a Markdown H1 with the
 * site's name first (required), then a blockquote summary, then sections under H2 headings
 * that list links (`- [name](url): notes`).
 *
 * - `summary`: a blockquote line (`> …`) before the first H2.
 * - `sections`: H2 headings with at least one linked list item under them.
 * - `links`: Markdown links anywhere in the file (images not counted).
 * - `structured`: an H1 and at least one such section.
 */
export interface LlmsStructure {
  readonly bytes: number;
  readonly summary: boolean;
  readonly sections: number;
  readonly links: number;
  readonly structured: boolean;
  /** The link targets as written, in order. */
  readonly targets: readonly string[];
}

/**
 * Characters of a file read for its structure. An llms.txt is meant to be a short map; a
 * longer file is checked on its start, so the work stays small whatever a site serves.
 */
export const LLMS_STRUCTURE_MAX_CHARS = 256 * 1024;

/** Whitespace as `\s` matches it, tested one character at a time. */
const SPACE = /\s/;

/**
 * The Markdown link targets of a text, `[text](target "title")` but not images, in one pass:
 * every search starts after the last, so no text, however built, makes it slower than
 * linear. The link text may not hold `]` or a line break; the target holds no space, `)` or
 * `>`, and may sit in `<…>`; an optional quoted title follows.
 */
function linkTargets(text: string): string[] {
  const out: string[] = [];
  const length = text.length;
  let close = -1;
  let lineEnd = -1;
  let stop = -1;
  let at = 0;
  for (;;) {
    const open = text.indexOf('[', at);
    if (open === -1) break;
    if (close <= open) close = text.indexOf(']', open + 1);
    if (close === -1) break;
    if (lineEnd <= open) {
      // The next line break, or the end of the text when there is none (searched once).
      const found = text.indexOf('\n', open + 1);
      lineEnd = found === -1 ? length : found;
    }
    if (lineEnd < close) {
      // No link text crosses a line: every [ before this line break fails.
      at = lineEnd + 1;
      continue;
    }
    if (open > 0 && text[open - 1] === '!') {
      // An image's [ ; a later [ before the same ] may still start a link.
      at = open + 1;
      continue;
    }
    // Every [ before `close` leads to this same ], so one attempt decides them all.
    at = close + 1;
    if (text[close + 1] !== '(') continue;
    let p = close + 2;
    while (p < length && SPACE.test(text[p]!)) p += 1;
    if (text[p] === '<') p += 1;
    const from = p;
    // The target runs to the first `)`, `>` or space. Targets start further on each time, so
    // the end found last is reused while it lies ahead: no character is passed twice.
    if (stop < from) {
      stop = from;
      while (
        stop < length &&
        text[stop] !== ')' &&
        text[stop] !== '>' &&
        !SPACE.test(text[stop]!)
      ) {
        stop += 1;
      }
    }
    p = stop;
    if (p === from) continue;
    const target = text.slice(from, p);
    if (text[p] === '>') p += 1;
    // An optional title: spaces, then "…" (looked for within 1,000 characters).
    let q = p;
    while (q < length && SPACE.test(text[q]!)) q += 1;
    if (q > p && text[q] === '"') {
      const quote = text.indexOf('"', q + 1);
      if (quote !== -1 && quote - q <= 1000) {
        let r = quote + 1;
        while (r < length && SPACE.test(text[r]!)) r += 1;
        if (text[r] === ')') {
          out.push(target);
          at = r + 1;
          continue;
        }
      }
    }
    while (p < length && SPACE.test(text[p]!)) p += 1;
    if (text[p] === ')') {
      out.push(target);
      at = p + 1;
    }
  }
  return out;
}

/** Whether a line holds a link start: a `[` (not an image's) whose text closes with `](`. */
function hasLinkStart(line: string): boolean {
  let open = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '[') {
      if (index === 0 || line[index - 1] !== '!') open = true;
    } else if (char === ']') {
      if (open && line[index + 1] === '(') return true;
      open = false;
    }
  }
  return false;
}

export function llmsStructure(body: string): LlmsStructure {
  const full = body.replace(BOM, '');
  const text =
    full.length > LLMS_STRUCTURE_MAX_CHARS ? full.slice(0, LLMS_STRUCTURE_MAX_CHARS) : full;
  const lines = text.split(/\r\n|\r|\n/);
  let summary = false;
  let sections = 0;
  let inSection = false;
  let sectionHasLink = false;
  let seenH2 = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^##\s+\S/.test(trimmed) && !trimmed.startsWith('###')) {
      if (inSection && sectionHasLink) sections += 1;
      inSection = true;
      seenH2 = true;
      sectionHasLink = false;
      continue;
    }
    if (!seenH2 && /^>\s*\S/.test(trimmed)) summary = true;
    if (
      inSection &&
      /^[-*+]\s/.test(trimmed) &&
      trimmed.indexOf('](', 2) !== -1 &&
      hasLinkStart(trimmed)
    ) {
      sectionHasLink = true;
    }
  }
  if (inSection && sectionHasLink) sections += 1;
  const targets = linkTargets(text);
  return {
    bytes: Buffer.byteLength(full, 'utf8'),
    summary,
    sections,
    links: targets.length,
    structured: sections > 0,
    targets,
  };
}

/**
 * Whether an answer is an llms.txt: a 200, a text type that is not HTML, not a robots.txt
 * served at that address, and a body whose first non-empty line is a Markdown H1 (`# Name`),
 * which is the one part llmstxt.org requires.
 */
export function looksLikeLlmsTxt(
  status: number | null,
  contentType: string | null,
  body: string,
): boolean {
  if (status !== 200) return false;
  if (contentType !== null && !contentType.startsWith('text/')) return false;
  if (looksLikeHtml(contentType, body)) return false;
  if (looksLikeRobotsTxt(body)) return false;
  const first = body
    .replace(BOM, '')
    .split(/\r\n|\r|\n/)
    .find((line) => line.trim() !== '');
  return first !== undefined && /^# \S/.test(first.trimStart());
}

/** Why an answer is or is not an llms.txt. */
export type LlmsVerdict =
  /** An llms.txt: a 200 with a text type, not a page or a robots.txt, starting with an H1. */
  | 'llms_txt'
  /** No answer arrived (refused, unreachable, timed out). */
  | 'no_answer'
  /** 404 or 410: there is no file. */
  | 'not_found'
  /** Another status than 200. */
  | 'status'
  /** A 200 with a type that is not text. */
  | 'not_text'
  /** A 200 that is an HTML page (a site that answers every address with a page). */
  | 'html'
  /** A 200 that is a robots.txt served at this address. */
  | 'robots'
  /** A 200 that is text but does not start with a Markdown H1. */
  | 'no_h1';

/** The validation of one answer at `/llms.txt`. */
export interface LlmsReport {
  /** Whether the answer is an llms.txt (the soft-404 rule: a 200 alone is not enough). */
  readonly present: boolean;
  readonly verdict: LlmsVerdict;
  readonly status: number | null;
  readonly contentType: string | null;
  /** Bytes of the body read (after decompression). */
  readonly bytes: number;
  /** The body went over the size cap and was cut there. */
  readonly truncated: boolean;
  /** The first H1's text, as written, cut to 200 characters; null without one. */
  readonly h1: string | null;
  /** H1 headings outside code blocks; llmstxt.org asks for exactly one. */
  readonly h1Count: number;
  /** The structure, when the answer is an llms.txt. */
  readonly structure: LlmsStructure | null;
}

/** Characters of an H1 kept in a report. */
export const LLMS_H1_MAX = 200;

function headings(body: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of body.replace(BOM, '').split(/\r\n|\r|\n/)) {
    const trimmed = line.trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^# \S/.test(trimmed)) found.push(trimmed.slice(2).trim());
  }
  return found;
}

/**
 * Validates an answer at `/llms.txt` against the llmstxt.org format, after the soft-404 rule:
 * an answer that is not a 200, is HTML, is a robots.txt, or does not start with an H1 is not
 * an llms.txt, whatever its status. Pure: pass what was fetched.
 */
export function validateLlmsTxt(answer: {
  readonly status: number | null;
  readonly contentType: string | null;
  readonly body: string | null;
  readonly truncated: boolean;
}): LlmsReport {
  const body = answer.body ?? '';
  const base = {
    status: answer.status,
    contentType: answer.contentType,
    bytes: Buffer.byteLength(body, 'utf8'),
    truncated: answer.truncated,
  };
  const verdict = ((): LlmsVerdict => {
    if (answer.status === null) return 'no_answer';
    if (answer.status === 404 || answer.status === 410) return 'not_found';
    if (answer.status !== 200) return 'status';
    if (answer.contentType !== null && !answer.contentType.startsWith('text/')) return 'not_text';
    if (looksLikeHtml(answer.contentType, body)) return 'html';
    if (looksLikeRobotsTxt(body)) return 'robots';
    return looksLikeLlmsTxt(answer.status, answer.contentType, body) ? 'llms_txt' : 'no_h1';
  })();
  if (verdict !== 'llms_txt') {
    return Object.freeze({
      ...base,
      present: false,
      verdict,
      h1: null,
      h1Count: 0,
      structure: null,
    });
  }
  const found = headings(body);
  return Object.freeze({
    ...base,
    present: true,
    verdict,
    h1: found[0] === undefined ? null : found[0].slice(0, LLMS_H1_MAX),
    h1Count: found.length,
    structure: llmsStructure(body),
  });
}
