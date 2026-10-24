/**
 * `readSitemap`: whether a file is a sitemap, and what kind. A file counts only by what it
 * holds: an HTML page at `/sitemap.xml` is not a sitemap (a site that answers every address with
 * a page), whatever its status. XML with a DOCTYPE or an ENTITY is refused unread, so no
 * entity can expand into more than the file holds.
 */
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { sitemapLocations } from '../generate';
import { looksLikeHtml } from '../llms';
import { isOnDomain, registrableDomain as defaultRegistrableDomain } from './domain';
import type { SitemapFacts, SitemapReason } from './types';

/** A sitemap is read to this many bytes after decompression (the fetch cap for a sitemap). */
export const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
/** `<loc>` entries or text lines counted at most. */
export const MAX_LOCS_COUNTED = 100_000;
/** Addresses looked at to decide whether any is on the site. */
const LOCS_CHECKED = 500;

export interface ReadSitemapOptions {
  /** The bytes were already cut at the fetch cap. */
  readonly truncated?: boolean;
  readonly registrableDomain?: (host: string) => string;
}

const GZIP_MAGIC = [0x1f, 0x8b];

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** Inflates a gzip stream to at most `cap` bytes; the rest is dropped. Null when it is corrupt. */
async function inflateCapped(
  bytes: Uint8Array,
  cap: number,
): Promise<{ data: Buffer; truncated: boolean } | null> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  try {
    Readable.from([Buffer.from(bytes)]).pipe(gunzip);
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      const room = cap - kept;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        kept += room;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      kept += chunk.length;
    }
  } catch {
    return null;
  } finally {
    gunzip.destroy();
  }
  return { data: Buffer.concat(chunks, kept), truncated };
}

function decode(bytes: Uint8Array, truncated: boolean): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2), { stream: truncated });
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2), { stream: truncated });
  }
  return new TextDecoder('utf-8').decode(bytes, { stream: truncated });
}

function fail(
  outcome: 'not_a_sitemap' | 'malformed',
  reason: SitemapReason,
  base: Pick<SitemapFacts, 'gzip' | 'truncated' | 'bytes'>,
  kind: SitemapFacts['kind'] = null,
  locs = 0,
): SitemapFacts {
  return Object.freeze({ outcome, kind, reason, locs, ...base });
}

const SITEMAP_NAMESPACE = 'http://www\\.sitemaps\\.org/schemas/sitemap/0\\.9';

function escapePrefix(prefix: string): string {
  return prefix.replace(/[.-]/g, '\\$&');
}

/**
 * The last 256 characters before any trailing whitespace, comments and processing instructions
 * (WordPress SEO plugins end a sitemap with a comment after the closing tag). Linear: each step
 * moves the end back.
 */
function tailBeforeComments(xml: string): string {
  let end = xml.length;
  for (let step = 0; step < 100; step += 1) {
    while (end > 0 && /\s/.test(xml.charAt(end - 1))) end -= 1;
    if (end >= 3 && xml.startsWith('-->', end - 3)) {
      const start = xml.lastIndexOf('<!--', end - 3);
      if (start === -1) break;
      end = start;
    } else if (end >= 2 && xml.startsWith('?>', end - 2)) {
      const start = xml.lastIndexOf('<?', end - 2);
      if (start === -1) break;
      end = start;
    } else {
      break;
    }
  }
  return xml.slice(Math.max(0, end - 256), end);
}

const XML_PROLOG = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*/;

/** Counts `<loc>` start tags, up to `MAX_LOCS_COUNTED`. */
function countLocs(xml: string): number {
  const pattern = /<loc[\s>]/gi;
  let count = 0;
  while (pattern.exec(xml) !== null) {
    count += 1;
    if (count >= MAX_LOCS_COUNTED) break;
  }
  return count;
}

/**
 * The sitemap rules on text that is already decoded and inflated. `truncated` says the text was
 * cut at the cap: it is then read as far as it goes.
 */
export function readSitemapText(
  text: string,
  contentType: string | null,
  siteUrl: string,
  options: ReadSitemapOptions & { readonly gzip?: boolean } = {},
): SitemapFacts {
  const registrable = options.registrableDomain ?? defaultRegistrableDomain;
  const truncated = options.truncated === true;
  const base = {
    gzip: options.gzip === true,
    truncated,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
  let siteDomain = '';
  try {
    siteDomain = registrable(new URL(siteUrl).hostname);
  } catch {
    siteDomain = '';
  }
  const onSite = (candidate: string): boolean => {
    try {
      const url = new URL(candidate);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        isOnDomain(url.hostname, siteDomain)
      );
    } catch {
      return false;
    }
  };

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return fail('not_a_sitemap', 'empty', base);
  // The body decides, not the header: a sitemap served with a wrong type is still a sitemap.
  if (looksLikeHtml(null, body)) return fail('not_a_sitemap', 'html', base);
  const servedAsHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';

  const first = body.trimStart().charAt(0);
  if (first === '<') {
    // XML. A DOCTYPE or an ENTITY (the way an entity bomb is written) is refused unread.
    if (/<!(?:doctype|entity)\b/i.test(body)) return fail('malformed', 'doctype', base);
    const afterProlog = body.slice(XML_PROLOG.exec(body)![0].length);
    const root = /^<(?:([A-Za-z][\w.-]*):)?([A-Za-z][\w.-]*)([^>]*)>?/.exec(afterProlog);
    const rootName = root?.[2]?.toLowerCase();
    const prefix = root?.[1];
    // A prefixed root counts when the prefix is bound to the sitemaps.org namespace.
    const prefixBound =
      prefix === undefined ||
      new RegExp(`xmlns:${escapePrefix(prefix)}\\s*=\\s*["']${SITEMAP_NAMESPACE}["']`).test(
        root?.[3] ?? '',
      );
    if ((rootName !== 'urlset' && rootName !== 'sitemapindex') || !prefixBound) {
      return fail('not_a_sitemap', servedAsHtml ? 'html' : 'bad_root', base);
    }
    const kind = rootName === 'urlset' ? 'urlset' : 'index';
    // The prefix is taken off the tags, so the rest reads one form.
    const xml =
      prefix === undefined
        ? body
        : body.replace(new RegExp(`<(/?)${escapePrefix(prefix)}:`, 'g'), '<$1');
    const locs = countLocs(xml);
    if (locs === 0) return fail('malformed', 'no_loc', base, kind);
    const listed = sitemapLocations(xml, LOCS_CHECKED).locations;
    if (listed.length === 0) return fail('malformed', 'no_loc', base, kind, locs);
    if (!listed.some(onSite)) return fail('malformed', 'off_site', base, kind, locs);
    if (!truncated && !new RegExp(`</${rootName}\\s*>$`, 'i').test(tailBeforeComments(xml))) {
      return fail('malformed', 'not_closed', base, kind, locs);
    }
    return Object.freeze({ outcome: 'valid', kind, reason: null, locs, ...base });
  }

  // A text sitemap: one absolute URL per line and nothing else.
  const lines = body.split(/\r\n|\r|\n/);
  // A file cut mid-line ends in a partial URL: leave that last line out.
  if (truncated) lines.pop();
  const urls = lines.map((line) => line.trim()).filter((line) => line !== '');
  const checked = urls.slice(0, MAX_LOCS_COUNTED);
  if (checked.length === 0 || checked.some((line) => !/^https?:\/\/\S+$/i.test(line))) {
    return fail('not_a_sitemap', servedAsHtml ? 'html' : 'text_lines', base);
  }
  if (!checked.slice(0, LOCS_CHECKED).some(onSite)) {
    return fail('malformed', 'off_site', base, 'text', checked.length);
  }
  return Object.freeze({
    outcome: 'valid',
    kind: 'text',
    reason: null,
    locs: checked.length,
    ...base,
  });
}

/**
 * Reads a sitemap file from its bytes as served. A gzip file (the `.gz` sitemap, found by its
 * two first bytes) is inflated to at most `SITEMAP_MAX_BYTES`; a file that goes past the cap is
 * cut there and reported as `truncated`, and valid as far as it was read. `siteUrl` is the
 * site's own address: only `<loc>` entries on its registrable domain count.
 */
export async function readSitemap(
  bytes: Uint8Array,
  contentType: string | null,
  siteUrl: string,
  options: ReadSitemapOptions = {},
): Promise<SitemapFacts> {
  let data: Uint8Array = bytes;
  let truncated = options.truncated === true;
  let gzip = false;
  if (isGzip(bytes)) {
    gzip = true;
    const inflated = await inflateCapped(bytes, SITEMAP_MAX_BYTES);
    if (inflated === null) {
      return fail('malformed', 'gzip_failed', { gzip: true, truncated: false, bytes: 0 });
    }
    data = inflated.data;
    truncated = inflated.truncated;
  } else if (bytes.length > SITEMAP_MAX_BYTES) {
    data = bytes.subarray(0, SITEMAP_MAX_BYTES);
    truncated = true;
  }
  const text = decode(data, truncated);
  const facts = readSitemapText(text, contentType, siteUrl, { ...options, truncated, gzip });
  return Object.freeze({ ...facts, bytes: data.length });
}
