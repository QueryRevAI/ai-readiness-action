/**
 * `readHomePage`: every fact the study and `checkSite` read from a home page's HTML, by one
 * pure function. The page's text is read as served: no script is run.
 */
import { countWords } from './words';
import { EMPTY_SHELL_MAX_WORDS, EMPTY_SHELL_MIN_BYTES, JS_NOTICE } from './app-shell';
import { normalizeHost, registrableDomain as defaultRegistrableDomain } from './domain';
import { hasAppRoot, scanPage } from './html';
import { isHomeChallenge } from './marks';
import { schemaTypeName, walkJsonLd } from './json-ld';
import {
  describeOrganization,
  hasSearchAction,
  isOrganizationType,
  organizationNodes,
  primaryOrganization,
} from './organization';
import type { HomeContent, HomePageFacts, OrganizationSource } from './types';

/** A home page with at least this many words of main text has "text in the HTML". */
export const TEXT_IN_HTML_MIN_WORDS = 150;
const MAX_TYPES = 200;
const SCHEMA_TYPE_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export interface ReadHomePageOptions {
  /** The values of the `X-Robots-Tag` response header, if any. */
  readonly xRobotsTag?: string | readonly string[] | null;
  /** Maps a host name to its registrable domain; the built-in rule knows common suffixes only. */
  readonly registrableDomain?: (host: string) => string;
}

/** `noindex` (or `none`, which means it) in a robots meta or header value, without an agent prefix. */
function sayNoindex(value: string): boolean {
  return value.split(',').some((token) => {
    const word = token.trim().toLowerCase();
    return word === 'noindex' || word === 'none';
  });
}

/**
 * Whether `X-Robots-Tag` values say noindex to every crawler. A value may start with an agent
 * (`googlebot: noindex, nofollow`), which then applies to the rest of that value up to the next
 * agent; such a rule is for one crawler and does not count. `unavailable_after: <date>` is a
 * directive, not an agent.
 */
export function xRobotsNoindex(values: string | readonly string[] | null | undefined): boolean {
  if (values === null || values === undefined) return false;
  const list = typeof values === 'string' ? [values] : values;
  for (const value of list.slice(0, 20)) {
    let agent: string | null = null;
    for (const token of value.slice(0, 2_000).split(',')) {
      let directive = token;
      const prefix = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/s.exec(token);
      if (prefix !== null && prefix[1]!.toLowerCase() !== 'unavailable_after') {
        agent = prefix[1]!.toLowerCase();
        directive = prefix[2]!;
      }
      if (agent === null && sayNoindex(directive)) return true;
    }
  }
  return false;
}

/** Reads the facts of a home page. Never throws. */
export function readHomePage(
  html: string,
  url: string,
  options: ReadHomePageOptions = {},
): HomePageFacts {
  const registrable = options.registrableDomain ?? defaultRegistrableDomain;
  let host = '';
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    host = '';
  }
  const siteDomain = registrable(host);
  const bytes = Buffer.byteLength(html, 'utf8');
  const scan = scanPage(html);

  const mainSource = scan.hasMain ? 'main' : 'body';
  const counted = countWords(mainSource === 'main' ? scan.mainText : scan.bodyText);
  const appRoot = hasAppRoot(html);
  const jsNotice = JS_NOTICE.test(`${scan.noticeText} ${scan.visibleText}`);
  let content: HomeContent;
  if (
    bytes > EMPTY_SHELL_MIN_BYTES &&
    counted.words < EMPTY_SHELL_MAX_WORDS &&
    (appRoot || jsNotice)
  ) {
    content = 'app_shell';
  } else if (counted.words >= TEXT_IN_HTML_MIN_WORDS) {
    content = 'text_in_html';
  } else {
    content = 'little_text';
  }

  const botCheck = isHomeChallenge(null, `${scan.noticeText} ${scan.visibleText}`, counted.words);
  const metaNoindex = scan.metaRobots.some(sayNoindex);
  const headerNoindex = xRobotsNoindex(options.xRobotsTag);

  // Structured data.
  const walk = walkJsonLd(scan.ldBlocks, scan.ldScripts, scan.ldBounds);
  const types: string[] = [];
  const typeSet = new Set<string>();
  const addType = (name: string): void => {
    if (!SCHEMA_TYPE_NAME.test(name) || typeSet.has(name) || typeSet.size >= MAX_TYPES) return;
    typeSet.add(name);
    types.push(name);
  };
  for (const { types: names } of walk.typed) for (const name of names) addType(name);
  const microdataTypes: string[] = [];
  for (const token of scan.itemtypes) {
    if (!/^https?:\/\/(?:www\.)?schema\.org\//i.test(token)) continue;
    const name = schemaTypeName(token);
    if (!microdataTypes.includes(name)) microdataTypes.push(name);
    addType(name);
  }

  const orgNodes = organizationNodes(walk.typed);
  const primaryNode = primaryOrganization(orgNodes, siteDomain, registrable);
  const primary =
    primaryNode === null ? null : describeOrganization(primaryNode, url, siteDomain, registrable);
  const microOrg = microdataTypes.find(isOrganizationType) ?? null;
  const organization: OrganizationSource =
    primary !== null ? 'json_ld' : microOrg !== null ? 'microdata' : 'none';

  const websites = walk.typed.filter(({ types: names }) => names.includes('WebSite'));
  const searchAction =
    websites.some(({ node }) => hasSearchAction(node)) ||
    (microdataTypes.includes('WebSite') && microdataTypes.includes('SearchAction'));

  return Object.freeze({
    url,
    host,
    bytes,
    scanTruncated: scan.truncated,
    mainWords: counted.words,
    wordsCapped: counted.capped,
    mainSource,
    content,
    appRoot,
    jsNotice,
    botCheck,
    noindex: metaNoindex || headerNoindex,
    noindexSource:
      metaNoindex && headerNoindex
        ? 'both'
        : metaNoindex
          ? 'meta'
          : headerNoindex
            ? 'header'
            : null,
    jsonLd: Object.freeze({
      scripts: walk.scripts,
      parsed: walk.parsed,
      schemaOrgBlocks: walk.schemaOrgBlocks,
      errors: walk.errors,
      bounds: walk.bounds,
    }),
    types: Object.freeze(types),
    microdataTypes: Object.freeze(microdataTypes),
    organization,
    organizationType: primary?.type ?? microOrg,
    primary,
    website: websites.length > 0 || microdataTypes.includes('WebSite'),
    searchAction,
    faqPage:
      walk.typed.some(({ types: names }) => names.includes('FAQPage')) ||
      microdataTypes.includes('FAQPage'),
  });
}
