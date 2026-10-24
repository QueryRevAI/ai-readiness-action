/**
 * One forward pass over a page's HTML, read from a string the way a crawler that runs no
 * scripts receives it. It collects what the readers need: the text of the main content, the
 * text a visitor sees, the robots meta tags, the `itemtype` values of microdata, the
 * JSON-LD scripts, and the notice text inside `<noscript>`.
 *
 * It is not an HTML parser and makes no tree. Elements that matter are tracked by a depth
 * counter per name, so nothing here costs more than one step per tag: a search starts where
 * the last one ended, and a search that finds nothing ends the scan. A test feeds it hostile
 * pages at the 2 MiB cap and checks the time.
 */
import { attributes } from '../generate';
import { isAppRoot } from './app-shell';
import type { JsonLdBound } from './types';

/** Characters of a page scanned; the fetch cap for a page is 2 MiB, so a fetched page fits. */
export const HOME_SCAN_MAX_CHARS = 2 * 1024 * 1024;
/** JSON-LD limits: blocks read, one block's size, all blocks' size (in characters). */
export const MAX_LD_BLOCKS = 50;
export const MAX_LD_BLOCK_CHARS = 512 * 1024;
export const MAX_LD_TOTAL_CHARS = 1024 * 1024;
/** Characters kept of the visible text and of `<noscript>` and `<title>` text, for notices. */
const NOTICE_TEXT_CHARS = 64 * 1024;
const MAX_ITEMTYPES = 200;
const MAX_ITEMTYPE_CHARS = 200;
const MAX_META_CHARS = 1_000;
/** Elements that belong in the head; any other start tag ends it, as a browser would. */
const HEAD_ELEMENTS = new Set([
  'title',
  'meta',
  'link',
  'script',
  'style',
  'base',
  'noscript',
  'template',
  'head',
]);
/** Page-level elements left out of the fallback text (a page without `<main>`). */
const CHROME = new Set(['header', 'nav', 'footer', 'aside']);

/** Elements that continue a word: `Hel<b>lo</b>` is one word. Every other tag ends one. */
const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

/** Elements whose content is not page text; the scan jumps to the closing tag. */
const RAW_TEXT = new Set([
  'style',
  'textarea',
  'xmp',
  'noframes',
  'noembed',
  'iframe',
  'title',
  'noscript',
  'script',
]);

const NAMED_TEXT_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hairsp: ' ',
  zwnj: '',
  zwj: '',
  shy: '',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  raquo: '»',
  laquo: '«',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  deg: '°',
  para: '¶',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  check: '✓',
  hearts: '♥',
  star: '☆',
  plusmn: '±',
  frac12: '½',
  infin: '∞',
});

/**
 * Entities in a text chunk decoded. A named entity not in the list above is almost always an
 * accented letter (`&eacute;`), so it becomes one letter and joins its word.
 */
function decodeText(raw: string): string {
  return raw.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
        if (code >= 0xd800 && code <= 0xdfff) return ' ';
        return String.fromCodePoint(code);
      }
      return NAMED_TEXT_ENTITIES[body] ?? NAMED_TEXT_ENTITIES[body.toLowerCase()] ?? 'e';
    },
  );
}

const CLOSING = new Map<string, RegExp>();

/** The next `</name` (any case) at or after `from`; -1 when there is none. */
function findClosing(html: string, name: string, from: number): number {
  let pattern = CLOSING.get(name);
  if (pattern === undefined) {
    pattern = new RegExp(`</${name}`, 'ig');
    CLOSING.set(name, pattern);
  }
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

function isLetter(code: number): boolean {
  const lower = code | 32;
  return lower >= 97 && lower <= 122;
}

/** The end of a start tag's name: letters, digits, `-`, `:`. */
function nameEnd(html: string, from: number): number {
  let at = from;
  for (;;) {
    const code = html.charCodeAt(at);
    if (isLetter(code) || (code >= 48 && code <= 58) || code === 45) at += 1;
    else return at;
  }
}

/**
 * The `>` that ends a start tag: quotes opened right after `=` are skipped, so `title="a>b"`
 * does not end it. -1 when the tag never ends.
 */
function findTagEnd(html: string, from: number): number {
  let at = from;
  let afterEquals = false;
  for (;;) {
    const code = html.charCodeAt(at);
    if (Number.isNaN(code)) return -1;
    if (code === 62) return at;
    if ((code === 34 || code === 39) && afterEquals) {
      const close = html.indexOf(code === 34 ? '"' : "'", at + 1);
      if (close === -1) return -1;
      at = close + 1;
      afterEquals = false;
      continue;
    }
    if (code === 61) afterEquals = true;
    else if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) {
      afterEquals = false;
    }
    at += 1;
  }
}

/** What one pass over a page found. */
export interface PageScan {
  /** Text of `<main>` and `[role=main]`; empty when `hasMain` is false. */
  readonly mainText: string;
  /** Text of the body without `header`, `nav`, `footer` and `aside`. */
  readonly bodyText: string;
  readonly hasMain: boolean;
  /** What a visitor sees (no scripts, styles, templates), cut to 64 KiB. */
  readonly visibleText: string;
  /** Text inside `<noscript>` and `<title>`, cut to 64 KiB. */
  readonly noticeText: string;
  /** `content` of every `<meta name="robots">`. */
  readonly metaRobots: readonly string[];
  /** `itemtype` values, split on spaces, at most 200. */
  readonly itemtypes: readonly string[];
  /** Contents of the `<script type="application/ld+json">` blocks that were read. */
  readonly ldBlocks: readonly string[];
  /** ld+json scripts found, whether or not they were read. */
  readonly ldScripts: number;
  readonly ldBounds: readonly JsonLdBound[];
  /** The input was longer than `HOME_SCAN_MAX_CHARS`. */
  readonly truncated: boolean;
}

function stripTags(raw: string): string {
  return raw.replace(/<[^<>]*>/g, ' ');
}

/** Scans a page. Never throws; text it cannot make sense of is left out. */
export function scanPage(input: string): PageScan {
  const truncated = input.length > HOME_SCAN_MAX_CHARS;
  const html = truncated ? input.slice(0, HOME_SCAN_MAX_CHARS) : input;
  const main: string[] = [];
  const body: string[] = [];
  const visible: string[] = [];
  let visibleLength = 0;
  const notice: string[] = [];
  let noticeLength = 0;
  const metaRobots: string[] = [];
  const itemtypes: string[] = [];
  const ldBlocks: string[] = [];
  const ldBounds = new Set<JsonLdBound>();
  let ldScripts = 0;
  let ldTotal = 0;
  let ldStopped = false;

  let mainDepth = 0;
  let hasMain = false;
  let roleName: string | null = null;
  let roleDepth = 0;
  const chrome = new Map<string, number>();
  let chromeDepth = 0;
  let skipDepth = 0;
  let inHead = false;
  let pendingSeparator = false;

  const addNotice = (text: string): void => {
    if (noticeLength >= NOTICE_TEXT_CHARS) return;
    notice.push(text);
    noticeLength += text.length;
  };

  const emit = (raw: string): void => {
    if (raw === '' || skipDepth > 0) return;
    if (inHead && raw.trim() !== '') inHead = false;
    if (inHead) return;
    const inMain = mainDepth > 0 || roleDepth > 0;
    const inBody = chromeDepth === 0;
    const decoded = raw.includes('&') ? decodeText(raw) : raw;
    const piece = pendingSeparator ? ` ${decoded}` : decoded;
    pendingSeparator = false;
    if (inMain) main.push(piece);
    if (inBody) body.push(piece);
    if (visibleLength < NOTICE_TEXT_CHARS) {
      visible.push(piece);
      visibleLength += piece.length;
    }
  };

  let textFrom = 0;
  let at = 0;
  for (;;) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    const next = html.charCodeAt(open + 1);
    if (next === 33 || next === 63) {
      // A comment, a doctype, a CDATA section or a processing instruction.
      emit(html.slice(textFrom, open));
      if (html.startsWith('<!--', open)) {
        const end = html.indexOf('-->', open + 4);
        if (end === -1) {
          textFrom = html.length;
          break;
        }
        at = end + 3;
      } else {
        const end = html.indexOf('>', open + 2);
        if (end === -1) {
          textFrom = html.length;
          break;
        }
        at = end + 1;
      }
      textFrom = at;
      continue;
    }
    const closing = next === 47;
    const nameFrom = open + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(nameFrom))) {
      // A "<" that starts no tag is text.
      at = open + 1;
      continue;
    }
    const nameTo = nameEnd(html, nameFrom);
    const name = html.slice(nameFrom, nameTo).toLowerCase();
    if (open > textFrom) emit(html.slice(textFrom, open));

    if (closing) {
      const end = html.indexOf('>', nameTo);
      if (end === -1) {
        textFrom = html.length;
        break;
      }
      at = end + 1;
      textFrom = at;
      if (name === 'main') {
        if (mainDepth > 0) mainDepth -= 1;
      } else if (CHROME.has(name)) {
        const depth = chrome.get(name) ?? 0;
        if (depth > 0) {
          chrome.set(name, depth - 1);
          chromeDepth -= 1;
        }
      } else if (name === 'template' || name === 'svg') {
        if (skipDepth > 0) skipDepth -= 1;
      } else if (name === 'head') {
        inHead = false;
      }
      if (name === roleName) {
        roleDepth -= 1;
        if (roleDepth === 0) roleName = null;
      }
      if (!INLINE.has(name)) pendingSeparator = true;
      continue;
    }

    if (inHead && !HEAD_ELEMENTS.has(name)) inHead = false;
    const tagEnd = findTagEnd(html, nameTo);
    if (tagEnd === -1) {
      textFrom = html.length;
      break;
    }
    const raw = tagEnd === nameTo ? '' : html.slice(nameTo, tagEnd);
    const selfClosing = html.charCodeAt(tagEnd - 1) === 47;
    at = tagEnd + 1;
    textFrom = at;

    if (RAW_TEXT.has(name)) {
      const end = findClosing(html, name, at);
      if (end === -1) {
        textFrom = html.length;
        at = html.length;
        break;
      }
      if (name === 'script') {
        const attrs = attributes(raw);
        const type = (attrs.get('type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (type === 'application/ld+json') {
          ldScripts += 1;
          const size = end - at;
          if (ldStopped) {
            // Past a limit: the rest is counted, not read.
          } else if (ldBlocks.length >= MAX_LD_BLOCKS) {
            ldBounds.add('blocks');
            ldStopped = true;
          } else if (size > MAX_LD_BLOCK_CHARS) {
            ldBounds.add('block_size');
          } else if (ldTotal + size > MAX_LD_TOTAL_CHARS) {
            ldBounds.add('total_size');
            ldStopped = true;
          } else {
            ldBlocks.push(html.slice(at, end));
            ldTotal += size;
          }
        }
      } else if (name === 'noscript' || name === 'title') {
        if (noticeLength < NOTICE_TEXT_CHARS) {
          addNotice(stripTags(html.slice(at, Math.min(end, at + NOTICE_TEXT_CHARS))) + ' ');
        }
      }
      at = end;
      textFrom = end;
      pendingSeparator = true;
      continue;
    }

    if (name === 'meta') {
      if (/name\s*=/i.test(raw)) {
        const attrs = attributes(raw);
        if ((attrs.get('name') ?? '').trim().toLowerCase() === 'robots') {
          metaRobots.push((attrs.get('content') ?? '').slice(0, MAX_META_CHARS));
        }
      }
      pendingSeparator = true;
      continue;
    }

    if (name === 'main') {
      mainDepth += 1;
      hasMain = true;
    } else if (CHROME.has(name)) {
      chrome.set(name, (chrome.get(name) ?? 0) + 1);
      chromeDepth += 1;
    } else if ((name === 'template' || name === 'svg') && !(selfClosing && name === 'svg')) {
      skipDepth += 1;
    } else if (name === 'head') {
      inHead = true;
    } else if (name === 'body') {
      inHead = false;
    }

    let opensRole = false;
    if (raw.length > 6 && /itemtype|role/i.test(raw)) {
      const attrs = attributes(raw);
      const itemtype = attrs.get('itemtype');
      if (itemtype !== undefined) {
        for (const token of itemtype.split(/\s+/)) {
          if (token !== '' && itemtypes.length < MAX_ITEMTYPES) {
            itemtypes.push(token.slice(0, MAX_ITEMTYPE_CHARS));
          }
        }
      }
      const role = (attrs.get('role') ?? '').trim().split(/\s+/)[0]!.toLowerCase();
      if (roleName === null && role === 'main' && !selfClosing) {
        roleName = name;
        roleDepth = 1;
        hasMain = true;
        opensRole = true;
      }
    }
    // A nested element of the same name as the `[role=main]` one, so its closing tag is not
    // mistaken for the end of the region.
    if (!opensRole && roleName !== null && name === roleName && !selfClosing) roleDepth += 1;
    if (!INLINE.has(name)) pendingSeparator = true;
  }
  emit(html.slice(textFrom));

  return Object.freeze({
    mainText: main.join(''),
    bodyText: body.join(''),
    hasMain,
    visibleText: visible.join(''),
    noticeText: notice.join(''),
    metaRobots,
    itemtypes,
    ldBlocks,
    ldScripts,
    ldBounds: [...ldBounds],
    truncated,
  });
}

/**
 * Whether the page has an application root element (see `isAppRoot`): a second, light pass over
 * the start tags that stops at the first one found.
 */
export function hasAppRoot(input: string): boolean {
  const html = input.length > HOME_SCAN_MAX_CHARS ? input.slice(0, HOME_SCAN_MAX_CHARS) : input;
  let at = 0;
  for (;;) {
    const open = html.indexOf('<', at);
    if (open === -1) return false;
    const next = html.charCodeAt(open + 1);
    if (next === 33 || next === 63) {
      const end = html.startsWith('<!--', open)
        ? html.indexOf('-->', open + 4)
        : html.indexOf('>', open + 2);
      if (end === -1) return false;
      at = end + (html.startsWith('<!--', open) ? 3 : 1);
      continue;
    }
    if (next === 47 || !isLetter(next)) {
      at = open + 1;
      continue;
    }
    const nameTo = nameEnd(html, open + 1);
    const name = html.slice(open + 1, nameTo).toLowerCase();
    const tagEnd = findTagEnd(html, nameTo);
    if (tagEnd === -1) return false;
    at = tagEnd + 1;
    if (RAW_TEXT.has(name)) {
      const end = findClosing(html, name, at);
      if (end === -1) return false;
      at = end;
      continue;
    }
    if (name === 'app-root') return true;
    const raw = tagEnd === nameTo ? '' : html.slice(nameTo, tagEnd);
    if (
      raw.length > 4 &&
      /\bid\s*=|ng-version|ng-app|data-reactroot|data-server-rendered/i.test(raw)
    ) {
      if (isAppRoot(name, attributes(raw))) return true;
    }
  }
}
