/**
 * Reading a page's bytes as text. One decoder for the library and for any program that uses it,
 * so a page in windows-1251, Shift_JIS, GBK or EUC-KR is counted the same everywhere. The order
 * is the one browsers use, shortened: a byte order mark; the `charset` of the Content-Type
 * header; a `<meta charset>` or `<meta http-equiv="Content-Type">` in the first 2 KiB; else
 * UTF-8. Labels are the WHATWG Encoding Standard's; a label it does not know is skipped.
 */

const LABEL = /^[a-z0-9_:.-]{2,40}$/i;
const HEAD_BYTES = 2048;

export interface DecodedText {
  readonly text: string;
  /** The encoding the bytes were read as (a WHATWG name, such as `windows-1251`). */
  readonly charset: string;
}

function known(label: string | undefined): string | null {
  if (label === undefined || !LABEL.test(label)) return null;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

/** The character set of a page by the rule above. */
export function detectCharset(bytes: Uint8Array, contentTypeHeader: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const fromHeader = known(/charset\s*=\s*["']?([^\s;"']+)/i.exec(contentTypeHeader ?? '')?.[1]);
  if (fromHeader !== null) return fromHeader;
  const head = Buffer.from(bytes.subarray(0, HEAD_BYTES)).toString('latin1');
  const fromMeta = known(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head)?.[1]);
  return fromMeta ?? 'utf-8';
}

/**
 * The bytes of an HTML page as text. `contentTypeHeader` is the raw `Content-Type` header, with
 * its parameters. A body cut at a size cap (`truncated`) loses no character to the cut: an
 * incomplete one at the end is held back.
 */
export function decodeHtml(
  bytes: Uint8Array,
  contentTypeHeader: string | null,
  truncated = false,
): DecodedText {
  const charset = detectCharset(bytes, contentTypeHeader);
  return { text: new TextDecoder(charset).decode(bytes, { stream: truncated }), charset };
}
