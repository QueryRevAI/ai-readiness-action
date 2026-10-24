import { crawlersCoveredLine } from '@queryrev/ai-readiness';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER } from './github';
import { llmsFindingsFor, robotsFindingsFor } from './report.testkit';
import { failingFindings, renderReport, type Report } from './report';
import { cell, code } from './text';

function report(overrides: Partial<Report> = {}): Report {
  const robots = robotsFindingsFor('User-agent: *\nAllow: /\n', 'User-agent: *\nDisallow: /\n');
  const llms = llmsFindingsFor();
  return {
    base: 'abc123',
    robots: { file: 'public/robots.txt', found: true, ...robots },
    llms: { file: 'public/llms.txt', found: true, findings: llms },
    online: null,
    ...overrides,
  };
}

describe('the summary', () => {
  it('names the result, what fails, the evidence line and the crawlers covered', () => {
    const text = renderReport(report(), { marker: false });
    expect(text).toContain('## AI readiness check: failed');
    expect(text).toContain('### What fails');
    expect(text).toContain('`Disallow: /`');
    expect(text).toContain('line 2');
    expect(text).toContain(crawlersCoveredLine());
    expect(text).toContain('Compared with `abc123`');
    expect(text.startsWith(COMMENT_MARKER)).toBe(false);
  });

  it('puts the marker first in the comment', () => {
    expect(renderReport(report(), { marker: true }).startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
  });

  it('has no score and does not claim to cover every crawler', () => {
    const text = renderReport(report(), { marker: true });
    expect(text).not.toMatch(/\bscore\b|\/ ?100|\d+ ?%/i);
    expect(text).not.toMatch(new RegExp(['all (the )?AI', ' crawlers'].join(''), 'i'));
  });

  it('passes a change that closes nothing, and says training crawlers never fail', () => {
    const robots = robotsFindingsFor(
      'User-agent: *\nAllow: /\n',
      'User-agent: GPTBot\nDisallow: /\n',
    );
    const ok = report({ robots: { file: 'public/robots.txt', found: true, ...robots } });
    expect(failingFindings(ok)).toEqual([]);
    const text = renderReport(ok, { marker: false });
    expect(text).toContain('## AI readiness check: passed');
    expect(text).toContain('never fail the check');
  });

  it('says so when there is no base', () => {
    expect(renderReport(report({ base: null }), { marker: false })).toContain('no base to compare');
  });

  it('keeps text from the files inert: code spans, no markup, no mention', () => {
    const hostile = 'Disallow: /@everyone <script>alert(1)</script> `|` #1 | x';
    const out = renderReport(
      report({
        llms: {
          file: 'public/llms.txt',
          found: true,
          findings: [{ id: 'x', level: 'warn', message: 'm', snippet: hostile }],
        },
      }),
      { marker: true },
    );
    const line = out.split('\n').find((row) => row.includes('<script>'))!;
    expect(line).toContain('``');
    // A pipe is escaped only inside a table.
    expect(line).not.toContain('\\|');
    expect(line.indexOf('<script>')).toBeGreaterThan(line.indexOf('`'));
  });

  it('shows the online check as reported only unless the input says it counts', () => {
    const online = {
      origin: 'https://www.example.com',
      unreadable: null,
      failOn: 'never' as const,
      findings: [
        { id: 'llms-txt-found', level: 'fail' as const, message: 'There is no llms.txt.' },
      ],
    };
    expect(failingFindings(report({ online }))).toHaveLength(failingFindings(report()).length);
    expect(failingFindings(report({ online: { ...online, failOn: 'fail' } }))).toHaveLength(
      failingFindings(report()).length + 1,
    );
    expect(renderReport(report({ online }), { marker: false })).toContain('reported only');
  });
});

describe('code spans', () => {
  it('uses a fence longer than any backtick run and one line, and escapes pipes in table cells only', () => {
    expect(code('a`b')).toBe('`` a`b ``');
    expect(code('a```b')).toBe('```` a```b ````');
    expect(code('a|b\nc')).toBe('`a|b c`');
    expect(cell('a|b\nc')).toBe('`a\\|b c`');
    expect(code('‮evil\u0007')).toBe('`evil`');
    expect(code('')).toBe('');
  });
});
