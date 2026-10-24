/**
 * llms.txt generation, as pure functions of text: what a page says about itself (its title,
 * first H1 and meta description, as written), the addresses a sitemap lists, and the file
 * built from them. Nothing here fetches; a caller reads the files with `fetchText` and passes
 * the text in.
 */

/** Characters kept of each field read from a page. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 500;

/** What a page says about itself. */
export interface PageMeta {
  /** The `<title>`, as written (entities decoded, whitespace collapsed); null without one. */
  readonly title: string | null;
  /** The first `<h1>`'s text; null without one. */
  readonly h1: string | null;
  /** `<meta name="description">`; null without one. */
  readonly description: string | null;
  /** A `<meta name="robots">` that says `noindex`. */
  readonly noindex: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
});

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g,
    (whole, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
        if (
          !Number.isInteger(code) ||
          code <= 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return whole;
        }
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/**
 * Control characters (C0 but tab and line breaks, DEL, C1), the bidirectional controls that
 * can reorder how text is displayed (including the Arabic letter mark) and the deprecated
 * format controls. Removed from every field read from a site.
 */
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u206f\u061c]/g;

/** Text from a site made safe to show: control and reordering characters removed. */
export function stripUnsafeCharacters(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, '');
}

/** Characters of a page read for its title, H1 and meta tags: its head and the start of its body. */
export const PAGE_SCAN_MAX_CHARS = 256 * 1024;
/** Characters of a sitemap scanned: its whole size cap (5 MiB), in one linear pass. */
export const SITEMAP_SCAN_MAX_CHARS = 5 * 1024 * 1024;
/**
 * `<loc>` tags looked at in one sitemap, empty or unusable ones included, before the scan
 * stops: enough for any list the tools take addresses from, and a bound on the work a file of
 * millions of empty tags can cause.
 */
export const MAX_LOC_TAGS_SCANNED = 10_000;
/** A sitemap address longer than this is left out. */
export const MAX_LOCATION_LENGTH = 2048;

/**
 * Every parser below reads remote text in one forward pass: each search starts where the last
 * one ended (`indexOf`, or a regular expression of fixed text from `lastIndex`), and a search
 * that finds nothing ends the scan. So no page or sitemap, however it is built, makes the work
 * more than linear in its length; a test feeds each one adversarial text at its cap.
 */

/** Tags removed, in one pass: a `<` with no `>` after it keeps the rest as text. */
function stripTags(raw: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = raw.indexOf('<', at);
    if (open === -1) return out + raw.slice(at);
    const close = raw.indexOf('>', open + 1);
    if (close === -1) return out + raw.slice(at);
    out += `${raw.slice(at, open)} `;
    at = close + 1;
  }
}

/** One line of plain text: entities decoded, tags removed, whitespace collapsed, cut to `max`. */
function plain(raw: string, max: number): string | null {
  const text = stripUnsafeCharacters(decodeEntities(stripTags(raw)))
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/** The attributes of one tag's text (between its name and its `>`), in one pass. */
export function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  const length = tag.length;
  let at = 0;
  while (at < length) {
    while (at < length && (isSpace(tag[at]) || tag[at] === '/')) at += 1;
    const from = at;
    while (at < length && !isSpace(tag[at]) && tag[at] !== '=' && tag[at] !== '/') at += 1;
    const name = tag.slice(from, at).toLowerCase();
    if (name === '') {
      at += 1;
      continue;
    }
    while (at < length && isSpace(tag[at])) at += 1;
    if (tag[at] !== '=') {
      // An attribute with no value (`data-reactroot`) is present, with an empty value.
      if (!found.has(name)) found.set(name, '');
      continue;
    }
    at += 1;
    while (at < length && isSpace(tag[at])) at += 1;
    let value: string;
    const quote = tag[at];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, at + 1);
      value = tag.slice(at + 1, end === -1 ? length : end);
      at = end === -1 ? length : end + 1;
    } else {
      const start = at;
      while (at < length && !isSpace(tag[at])) at += 1;
      value = tag.slice(start, at);
    }
    if (!found.has(name)) found.set(name, value);
  }
  return found;
}

/** The next `</name` (any case) at or after `from`; -1 when there is none. */
function closingTag(html: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}`, 'ig');
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

/** Elements whose content is not the page's own text. */
const RAW_TEXT = new Set(['script', 'style', 'template', 'noscript', 'textarea']);
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y;

/** Reads a page's title, first H1, meta description and robots meta from its HTML. */
export function pageMeta(input: string): PageMeta {
  const html = input.length > PAGE_SCAN_MAX_CHARS ? input.slice(0, PAGE_SCAN_MAX_CHARS) : input;
  let title: string | null = null;
  let h1: string | null = null;
  let description: string | null = null;
  let noindex = false;
  let at = 0;
  for (;;) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    TAG_NAME.lastIndex = open + 1;
    const match = TAG_NAME.exec(html);
    if (match === null) {
      at = open + 1;
      continue;
    }
    const name = match[0].toLowerCase();
    const tagEnd = html.indexOf('>', TAG_NAME.lastIndex);
    if (tagEnd === -1) break;
    at = tagEnd + 1;
    if (RAW_TEXT.has(name)) {
      const end = closingTag(html, name, at);
      if (end === -1) break;
      at = end;
      continue;
    }
    if (name === 'title' || name === 'h1') {
      const end = closingTag(html, name, at);
      if (end === -1) break;
      if (name === 'title' && title === null) title = plain(html.slice(at, end), TITLE_MAX);
      if (name === 'h1' && h1 === null) h1 = plain(html.slice(at, end), TITLE_MAX);
      at = end;
      continue;
    }
    if (name === 'meta') {
      const attrs = attributes(html.slice(TAG_NAME.lastIndex, tagEnd));
      const kind = (attrs.get('name') ?? '').toLowerCase();
      const content = attrs.get('content') ?? '';
      if (kind === 'description' && description === null) {
        description = plain(content, DESCRIPTION_MAX);
      }
      if (kind === 'robots' && /\bnoindex\b|\bnone\b/i.test(content)) noindex = true;
    }
  }
  return Object.freeze({ title, h1, description, noindex });
}

/** The addresses a sitemap file lists. */
export interface SitemapLocations {
  /** `urlset` lists pages; `index` lists other sitemaps; `unknown` is neither. */
  readonly kind: 'urlset' | 'index' | 'unknown';
  /** The `<loc>` values in order, entities decoded, at most `max`; none over 2,048 characters. */
  readonly locations: readonly string[];
}

/** Reads the `<loc>` addresses of a sitemap (sitemaps.org), up to `max` of them. */
export function sitemapLocations(input: string, max: number): SitemapLocations {
  const xml =
    input.length > SITEMAP_SCAN_MAX_CHARS ? input.slice(0, SITEMAP_SCAN_MAX_CHARS) : input;
  const kind = /<sitemapindex\b/i.test(xml)
    ? 'index'
    : /<urlset\b/i.test(xml)
      ? 'urlset'
      : 'unknown';
  const locations: string[] = [];
  const loc = /<loc\b/gi;
  let scanned = 0;
  while (kind !== 'unknown' && locations.length < max && scanned < MAX_LOC_TAGS_SCANNED) {
    const found = loc.exec(xml);
    if (found === null) break;
    scanned += 1;
    const tagEnd = xml.indexOf('>', loc.lastIndex);
    if (tagEnd === -1) break;
    let from = tagEnd + 1;
    while (isSpace(xml[from])) from += 1;
    let raw: string;
    if (xml.startsWith('<![CDATA[', from)) {
      const end = xml.indexOf(']]>', from + 9);
      if (end === -1) break;
      raw = xml.slice(from + 9, end);
      loc.lastIndex = end + 3;
    } else {
      const end = xml.indexOf('<', from);
      if (end === -1) break;
      raw = xml.slice(from, end);
      loc.lastIndex = end;
    }
    if (raw.length > MAX_LOCATION_LENGTH + 64) continue;
    const value = stripUnsafeCharacters(decodeEntities(raw.trim()));
    if (value !== '' && value.length <= MAX_LOCATION_LENGTH) locations.push(value);
  }
  return Object.freeze({ kind, locations: Object.freeze(locations) });
}

/** The site an llms.txt is about. */
export interface LlmsSite {
  /** Its name: the file's H1. */
  readonly name: string;
  /** One or two sentences about it: the summary blockquote. Null leaves it out. */
  readonly summary: string | null;
}

/** One page to list. */
export interface LlmsPage {
  /** Its absolute address. */
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
}

/** The section of pages that sit at the top of the site (no first path segment). */
export const MAIN_SECTION = 'Main pages';

function oneLine(text: string): string {
  return stripUnsafeCharacters(text).replace(/\s+/g, ' ').trim();
}

/** Link text with the characters that would end a Markdown link escaped. */
function linkText(text: string): string {
  return oneLine(text).replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/** A link target with the characters that would end a Markdown link encoded. */
function linkTarget(url: string): string {
  return url.replace(
    /[()\s<>]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** A first path segment as a section name: `getting-started` → `Getting started`. */
function sectionName(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // An escape that does not decode is kept as written.
  }
  const words = oneLine(decoded.replace(/[-_+.]+/g, ' ')).slice(0, 60);
  if (words === '') return MAIN_SECTION;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function segments(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter((part) => part !== '');
  } catch {
    return [];
  }
}

/**
 * The llms.txt for a site and its pages (llmstxt.org): the site's name as the H1, its summary
 * as a blockquote, then one H2 section per folder (first path segment with pages under it), in
 * the order the pages come, the other pages first under "Main pages". Each page is a list item
 * `- [title](url): description`, the description left out when there is none. Titles and
 * descriptions are used as written, on one line.
 */
export function renderLlmsTxt(site: LlmsSite, pages: readonly LlmsPage[]): string {
  // A folder with pages under it is a section; a page at the top joins its folder's section
  // when there is one (`/blog` beside `/blog/post`), else the main pages.
  const folders = new Set(
    pages
      .map((page) => segments(page.url))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0]!),
  );
  const sections = new Map<string, LlmsPage[]>();
  sections.set(MAIN_SECTION, []);
  for (const page of pages) {
    const first = segments(page.url)[0];
    const name = first !== undefined && folders.has(first) ? sectionName(first) : MAIN_SECTION;
    const list = sections.get(name) ?? [];
    list.push(page);
    sections.set(name, list);
  }
  const lines = [`# ${oneLine(site.name) || 'Site'}`, ''];
  const summary = site.summary === null ? '' : oneLine(site.summary);
  if (summary !== '') lines.push(`> ${summary}`, '');
  for (const [name, list] of sections) {
    if (list.length === 0) continue;
    lines.push(`## ${name}`, '');
    for (const page of list) {
      const description = page.description === null ? '' : oneLine(page.description);
      lines.push(
        `- [${linkText(page.title) || linkTarget(page.url)}](${linkTarget(page.url)})${description === '' ? '' : `: ${description}`}`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
