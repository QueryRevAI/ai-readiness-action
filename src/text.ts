import { stripUnsafeCharacters } from '@queryrev/ai-readiness';

// Text that reaches a pull request comment, a job summary or the log comes from files that a
// contributor controls, so it is made safe before it is shown: control and reordering characters
// removed, one line, cut short, and placed in a code span so that Markdown, HTML, @mentions and
// issue references in it stay inert.

/** One line of plain text from an untrusted source, cut to `max` characters. */
export function oneLine(text: string, max = 200): string {
  const line = stripUnsafeCharacters(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** An untrusted string as a Markdown code span. Use `cell` inside a table. */
export function code(text: string, max = 200): string {
  const line = oneLine(text, max);
  if (line === '') return '';
  let longest = 0;
  for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  return longest === 0 ? `\`${line}\`` : `${fence} ${line} ${fence}`;
}

/** A code span for a table cell: a pipe would end the cell, so it is escaped. */
export function cell(text: string, max = 200): string {
  return code(oneLine(text, max).replaceAll('|', '\\|'), max + 20);
}

/** Escapes the data of a workflow command, so a line of text cannot start another command. */
export function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Escapes a property of a workflow command (`file=`, `title=`). */
export function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}
