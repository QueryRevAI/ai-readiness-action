/**
 * What a fetched answer for the home page means: read, or not read and why. A pure function of
 * the fetch result, so the check and the study draw the same line.
 */
import { looksLikeHtml } from '../llms';
import { decodeHtml } from '../net/charset';
import type { TextFetchResult } from '../net/fetch-text';
import { placeholderMark } from './marks';
import { readHomePage, type ReadHomePageOptions } from './home-page';
import type { HomeRead } from './types';

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/** Reads the answer for the home page. `not_allowed` is not decided here: no request was made. */
export function readHomeResponse(
  result: TextFetchResult,
  options: Pick<ReadHomePageOptions, 'registrableDomain'> = {},
): HomeRead {
  const base = {
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    status: result.status,
    redirects: result.redirects.length,
    truncated: result.truncated,
    facts: null,
  } as const;
  const not = (outcome: Exclude<HomeRead['outcome'], 'read' | 'not_allowed'>): HomeRead =>
    Object.freeze({ ...base, outcome });

  if (result.outcome !== 'response') {
    if (result.outcome === 'redirect_refused') return not('off_site');
    if (
      result.outcome === 'too_many_redirects' ||
      result.outcome === 'redirect_loop' ||
      result.outcome === 'invalid_redirect'
    ) {
      return not('redirect_error');
    }
    return not('network');
  }
  const status = result.status ?? 0;
  if (status === 401 || status === 403) return not('forbidden');
  if (status === 202) return not('challenge');
  if (status !== 200) return not('error_status');
  // Decoded by the page's own character set when the bytes are at hand.
  const text =
    result.rawBody === null
      ? result.text
      : decodeHtml(result.rawBody, result.headers['content-type']?.[0] ?? null, result.truncated)
          .text;
  if (text === null) return not('not_html');
  const typed = result.contentType !== null;
  if (typed ? !HTML_TYPES.has(result.contentType) : !looksLikeHtml(null, text)) {
    return not('not_html');
  }
  const facts = readHomePage(text, result.finalUrl, {
    xRobotsTag: result.headers['x-robots-tag'] ?? null,
    ...(options.registrableDomain === undefined
      ? {}
      : { registrableDomain: options.registrableDomain }),
  });
  if (facts.botCheck) return not('challenge');
  if (placeholderMark(text, facts.mainWords) !== null) return not('placeholder');
  return Object.freeze({ ...base, outcome: 'read', facts });
}
