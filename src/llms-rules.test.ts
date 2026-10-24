import { describe, expect, it } from 'vitest';
import { compareLlms, validateFile } from './llms-rules';

const GOOD =
  '# Example\n\n> A site about examples.\n\n## Docs\n- [Start](https://www.example.com/start): begin here\n';
const FILE = 'public/llms.txt';

describe('an llms.txt that gets broken', () => {
  it('fails when the file is removed', () => {
    const { findings } = compareLlms(GOOD, null, FILE);
    expect(findings).toEqual([
      expect.objectContaining({ id: 'llms-txt-broken', level: 'fail', file: FILE }),
    ]);
    expect(findings[0]?.message).toContain('the file was removed');
  });

  it('fails when it becomes a page (a soft 404)', () => {
    const { findings } = compareLlms(
      GOOD,
      '<!doctype html><html><body>Not found</body></html>',
      FILE,
    );
    expect(findings[0]).toMatchObject({ id: 'llms-txt-broken', level: 'fail' });
    expect(findings[0]?.message).toContain('soft 404');
  });

  it('fails when it becomes a robots.txt', () => {
    const { findings } = compareLlms(GOOD, 'User-agent: *\nDisallow: /\n', FILE);
    expect(findings[0]).toMatchObject({ id: 'llms-txt-broken', level: 'fail' });
    expect(findings[0]?.message).toContain('a robots.txt');
  });

  it('fails when the H1 is lost', () => {
    const { findings } = compareLlms(
      GOOD,
      'A site about examples.\n\n## Docs\n- [Start](https://www.example.com/start)\n',
      FILE,
    );
    expect(findings[0]).toMatchObject({ id: 'llms-txt-broken', level: 'fail' });
    expect(findings[0]?.message).toContain('Markdown H1');
  });
});

describe('an llms.txt that is not broken by the change', () => {
  it('passes a valid file and reports its structure', () => {
    const { findings, report } = compareLlms(GOOD, GOOD, FILE);
    expect(report.present).toBe(true);
    expect(findings.every((finding) => finding.level === 'pass')).toBe(true);
    expect(findings.map((finding) => finding.id)).toContain('llms-txt-sections');
  });

  it('warns, and does not fail, about a missing summary or section', () => {
    const { findings } = compareLlms(undefined, '# Example\n\nSome text.\n', FILE);
    expect(findings.some((finding) => finding.level === 'fail')).toBe(false);
    expect(findings.filter((finding) => finding.level === 'warn').map((f) => f.id)).toEqual(
      expect.arrayContaining(['llms-txt-summary', 'llms-txt-sections']),
    );
  });

  it('is informational when there is no file before or after', () => {
    expect(compareLlms(null, null, FILE).findings).toEqual([
      expect.objectContaining({ id: 'llms-txt-absent', level: 'info' }),
    ]);
    expect(compareLlms(undefined, null, FILE).findings[0]?.level).toBe('info');
  });

  it('warns about a file that was not an llms.txt and still is not', () => {
    const page = '<html><body>hi</body></html>';
    const { findings } = compareLlms(page, page, FILE);
    expect(findings).toEqual([
      expect.objectContaining({ id: 'llms-txt-not-valid', level: 'warn' }),
    ]);
  });

  it('passes a file that was invalid and is fixed', () => {
    const { findings } = compareLlms('<html></html>', GOOD, FILE);
    expect(findings.some((finding) => finding.level === 'fail' || finding.level === 'warn')).toBe(
      false,
    );
  });

  it('reads a file with a byte order mark and Windows line breaks as a file', () => {
    expect(validateFile(`\uFEFF${GOOD.replaceAll('\n', '\r\n')}`).present).toBe(true);
  });

  it('cuts a file over 1 MiB and reports it', () => {
    const big = `${GOOD}${'- [x](https://www.example.com/x)\n'.repeat(60_000)}`;
    expect(validateFile(big).truncated).toBe(true);
  });
});
