/**
 * The findings of a site check, drawn from the facts it gathered. Each finding has a stable id,
 * a level, one plain sentence about this site, and the evidence it rests on. A finding is given
 * for a check that applies: Organization details are judged only when an Organization was found,
 * and the page's own checks only when the home page was read.
 */
import { stripUnsafeCharacters } from '../generate';
import { READER_TOKEN } from './reader';
import type {
  Finding,
  FindingLevel,
  HomeOutcome,
  HomePageFacts,
  SiteCheck,
  SitemapReason,
} from './types';

const DOC_BASE = 'https://queryrev.com/research/ai-search-readiness#';

/** Where each finding is explained: its own anchor where the method has one, else the method. */
const ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  'home-page-read': 'home-pages-read',
  'ai-search-crawler-access': 'readable-by-ai-search',
  'json-ld-on-home-page': 'json-ld-on-home-page',
  'json-ld-errors': 'json-ld-errors',
  'organization-schema': 'organization-schema',
  'organization-microdata-only': 'organization-microdata-only',
  'organization-name-and-url': 'organization-name-and-url',
  'organization-logo': 'organization-logo',
  'organization-same-as': 'organization-same-as',
  'website-schema': 'website-schema',
  'faq-schema': 'faq-schema',
  'text-in-html': 'text-in-html',
  'app-shell': 'app-shell',
  'little-text': 'little-text',
  'noindex-home-page': 'noindex-home-page',
  'sitemap-in-robots': 'sitemap-in-robots',
  'sitemap-valid': 'sitemap-valid',
  'sitemap-cut': 'sitemap-valid',
  'llms-txt-found': 'llms-txt-found',
});

/** The finding ids that exist, for tests and for tools that list them. */
export const FINDING_IDS: readonly string[] = Object.freeze([
  'site-refused',
  'robots-txt',
  'sitemap-in-robots',
  'reader-blocked',
  'ai-search-crawler-access',
  'ai-training-crawler-access',
  'home-page-read',
  'home-truncated',
  'noindex-home-page',
  'text-in-html',
  'app-shell',
  'little-text',
  'json-ld-on-home-page',
  'json-ld-errors',
  'json-ld-bounds',
  'organization-schema',
  'organization-microdata-only',
  'organization-name-and-url',
  'organization-logo',
  'organization-same-as',
  'website-schema',
  'faq-schema',
  'llms-txt-found',
  'llms-txt-structure',
  'sitemap-valid',
  'sitemap-cut',
]);

function finding(id: string, level: FindingLevel, message: string, snippet?: string): Finding {
  // Text from a site reaches messages and snippets; control and reordering characters go once, here.
  message = stripUnsafeCharacters(message);
  snippet = snippet === undefined ? undefined : stripUnsafeCharacters(snippet);
  const docUrl = `${DOC_BASE}${ANCHORS[id] ?? 'method'}`;
  return Object.freeze(
    snippet === undefined || snippet === ''
      ? { id, level, message, docUrl }
      : { id, level, message, docUrl, snippet: snippet.slice(0, 300) },
  );
}

const HOME_NOT_READ: Readonly<Record<Exclude<HomeOutcome, 'read'>, [FindingLevel, string]>> = {
  not_allowed: [
    'info',
    `robots.txt keeps ${READER_TOKEN} from the home page, so it was not requested.`,
  ],
  forbidden: ['warn', 'The home page answered 401 or 403 to this reader, so it was not read.'],
  challenge: ['warn', 'The home page answered with a bot check, so its content was not read.'],
  placeholder: [
    'fail',
    'The home page is a placeholder (a parking page or a server default page).',
  ],
  not_html: ['fail', 'The home page did not answer with an HTML document.'],
  error_status: ['fail', 'The home page did not answer with a normal 200 page.'],
  off_site: ['warn', 'The home page redirects to another site, which was not followed.'],
  redirect_error: ['fail', 'The home page redirects in a loop or too many times.'],
  network: ['warn', 'The home page could not be reached.'],
};

const SITEMAP_REASON: Readonly<Record<SitemapReason, string>> = {
  html: 'the address answers with an HTML page',
  empty: 'the file is empty',
  doctype: 'the XML has a DOCTYPE or ENTITY, which is not read',
  bad_root: 'the XML does not start with urlset or sitemapindex',
  no_loc: 'it lists no address',
  off_site: 'none of the addresses it lists is on this site',
  not_closed: 'the XML is not closed',
  text_lines: 'the text is not a list of addresses',
  gzip_failed: 'the gzip file cannot be inflated',
};

function pageFindings(page: HomePageFacts): Finding[] {
  const out: Finding[] = [];
  if (page.noindex) {
    out.push(
      finding(
        'noindex-home-page',
        'fail',
        'The home page tells crawlers not to index it (noindex).',
        `noindex in ${page.noindexSource === 'header' ? 'the X-Robots-Tag header' : page.noindexSource === 'both' ? 'the robots meta tag and the X-Robots-Tag header' : 'the robots meta tag'}`,
      ),
    );
  } else {
    out.push(finding('noindex-home-page', 'pass', 'The home page does not say noindex.'));
  }

  const words = `${page.mainWords}${page.wordsCapped ? '+' : ''}`;
  if (page.content === 'text_in_html') {
    out.push(
      finding(
        'text-in-html',
        'pass',
        `The page carries ${words} words of text in the HTML as served.`,
        `main text: ${words} words (${page.mainSource === 'main' ? 'main element' : 'body without header, navigation and footer'})`,
      ),
    );
  } else if (page.content === 'app_shell') {
    out.push(
      finding(
        'app-shell',
        'fail',
        `The page is served as an empty application shell: ${words} words of text, and the content needs scripts.`,
        page.appRoot ? 'an application root element is present' : 'the page asks for JavaScript',
      ),
    );
  } else {
    out.push(
      finding(
        'little-text',
        'warn',
        `The page carries ${words} words of text in the HTML as served, under 150.`,
      ),
    );
  }

  const ld = page.jsonLd;
  if (ld.schemaOrgBlocks > 0) {
    out.push(
      finding(
        'json-ld-on-home-page',
        'pass',
        `The home page has ${ld.schemaOrgBlocks} JSON-LD block${ld.schemaOrgBlocks === 1 ? '' : 's'} naming schema.org.`,
        page.types.slice(0, 12).join(', '),
      ),
    );
  } else {
    out.push(
      finding('json-ld-on-home-page', 'warn', 'The home page has no JSON-LD structured data.'),
    );
  }
  if (ld.errors > 0) {
    out.push(
      finding(
        'json-ld-errors',
        'warn',
        `${ld.errors} JSON-LD block${ld.errors === 1 ? '' : 's'} on the home page cannot be parsed as JSON.`,
      ),
    );
  }
  if (ld.bounds.length > 0) {
    out.push(
      finding(
        'json-ld-bounds',
        'info',
        'The structured data is larger than this reader reads; the rest was left out.',
        ld.bounds.join(', '),
      ),
    );
  }

  if (page.organization === 'json_ld' && page.primary !== null) {
    const primary = page.primary;
    out.push(
      finding(
        'organization-schema',
        'pass',
        `The home page describes the organization in JSON-LD (${primary.type}).`,
        primary.name ?? undefined,
      ),
    );
    out.push(
      primary.nameAndUrl
        ? finding(
            'organization-name-and-url',
            'pass',
            'The Organization has a name and a url.',
            `${primary.name ?? ''} ${primary.url ?? ''}`.trim(),
          )
        : finding(
            'organization-name-and-url',
            'warn',
            'The Organization lacks a name or an absolute http(s) url.',
          ),
    );
    out.push(
      primary.logo
        ? finding('organization-logo', 'pass', 'The Organization has a logo.')
        : finding('organization-logo', 'info', 'The Organization has no logo.'),
    );
    out.push(
      primary.sameAs.length > 0
        ? finding(
            'organization-same-as',
            'pass',
            `The Organization links ${primary.sameAs.length} profile${primary.sameAs.length === 1 ? '' : 's'} elsewhere with sameAs.`,
            primary.sameAsKinds.join(', '),
          )
        : finding(
            'organization-same-as',
            'warn',
            'The Organization has no sameAs link to a profile on another site.',
          ),
    );
  } else if (page.organization === 'microdata') {
    out.push(
      finding(
        'organization-microdata-only',
        'warn',
        'The organization is described in microdata only; no JSON-LD Organization was found.',
        page.organizationType ?? undefined,
      ),
    );
  } else {
    out.push(
      finding(
        'organization-schema',
        'warn',
        'The home page does not describe the organization in structured data.',
      ),
    );
  }

  out.push(
    page.website
      ? finding(
          'website-schema',
          'pass',
          page.searchAction
            ? 'The home page has WebSite data with a SearchAction.'
            : 'The home page has WebSite data.',
        )
      : finding('website-schema', 'info', 'The home page has no WebSite data.'),
  );
  if (page.faqPage) {
    out.push(finding('faq-schema', 'pass', 'The home page has FAQPage data.'));
  }
  return out;
}

/** The findings for the facts of a check. */
export function buildFindings(site: Omit<SiteCheck, 'findings'>): Finding[] {
  const out: Finding[] = [];
  const { robots } = site;

  if (robots.outcome === 'file') {
    out.push(finding('robots-txt', 'pass', `robots.txt found (${robots.bytes} bytes).`));
    out.push(
      robots.sitemaps.length > 0
        ? finding('sitemap-in-robots', 'pass', 'robots.txt lists a sitemap.', robots.sitemaps[0])
        : finding('sitemap-in-robots', 'info', 'robots.txt lists no sitemap.'),
    );
  } else if (robots.outcome === 'missing') {
    out.push(
      finding(
        'robots-txt',
        'info',
        'There is no robots.txt; nothing is closed to crawlers.',
        robots.status === null ? undefined : `status ${robots.status}`,
      ),
    );
  } else {
    out.push(
      finding(
        'robots-txt',
        'warn',
        'robots.txt could not be read, so nothing else was requested.',
        robots.status === null ? 'no answer' : `status ${robots.status}`,
      ),
    );
    return out;
  }

  if (!robots.allowsThisReader) {
    out.push(
      finding('reader-blocked', 'info', `robots.txt keeps ${READER_TOKEN} from the home page.`),
    );
  }

  const searchAndUser = site.crawlerAccess.filter((entry) => entry.purpose !== 'training');
  const closed = searchAndUser.filter((entry) => entry.access === 'blocked' || !entry.root);
  const partial = searchAndUser.filter((entry) => entry.access === 'partial' && entry.root);
  if (closed.length > 0) {
    out.push(
      finding(
        'ai-search-crawler-access',
        'fail',
        `robots.txt keeps ${closed.length} of ${searchAndUser.length} AI search and user-fetch crawlers from the home page.`,
        closed.map((entry) => entry.token).join(', '),
      ),
    );
  } else if (partial.length > 0) {
    out.push(
      finding(
        'ai-search-crawler-access',
        'warn',
        `robots.txt closes parts of the site to ${partial.length} of ${searchAndUser.length} AI search and user-fetch crawlers.`,
        partial.map((entry) => entry.token).join(', '),
      ),
    );
  } else {
    out.push(
      finding(
        'ai-search-crawler-access',
        'pass',
        `All ${searchAndUser.length} AI search and user-fetch crawlers on the list can read the home page.`,
      ),
    );
  }
  const training = site.crawlerAccess.filter((entry) => entry.purpose === 'training');
  const trainingClosed = training.filter((entry) => entry.access === 'blocked');
  out.push(
    finding(
      'ai-training-crawler-access',
      'info',
      trainingClosed.length === 0
        ? "No AI training crawler on the list is blocked. Blocking them is the site's choice."
        : `${trainingClosed.length} of ${training.length} AI training crawlers are blocked. Blocking them is the site's choice.`,
      trainingClosed.map((entry) => entry.token).join(', '),
    ),
  );

  const home = site.home;
  if (home !== null) {
    if (home.outcome === 'read' && home.facts !== null) {
      out.push(
        finding(
          'home-page-read',
          'pass',
          'The home page was read.',
          `${home.status ?? ''} ${home.finalUrl}`.trim(),
        ),
      );
      if (home.truncated || home.facts.scanTruncated) {
        out.push(
          finding(
            'home-truncated',
            'info',
            'The home page is larger than 2 MiB; it was read as far as the limit.',
          ),
        );
      }
      out.push(...pageFindings(home.facts));
    } else if (home.outcome !== 'read') {
      const [level, message] = HOME_NOT_READ[home.outcome];
      out.push(
        finding(
          'home-page-read',
          level,
          message,
          home.status === null ? undefined : `status ${home.status}`,
        ),
      );
    }
  }

  const llms = site.llms;
  if (!llms.asked) {
    out.push(
      finding(
        'llms-txt-found',
        'info',
        `robots.txt keeps ${READER_TOKEN} from /llms.txt, so it was not requested.`,
      ),
    );
  } else if (llms.present) {
    out.push(finding('llms-txt-found', 'pass', 'An llms.txt is present.', llms.h1 ?? undefined));
    const missing: string[] = [];
    if (llms.sections === 0) missing.push('a section of links');
    out.push(
      missing.length === 0
        ? finding(
            'llms-txt-structure',
            'pass',
            `The llms.txt has ${llms.sections} section${llms.sections === 1 ? '' : 's'} and ${llms.links} link${llms.links === 1 ? '' : 's'}.`,
          )
        : finding('llms-txt-structure', 'warn', `The llms.txt lacks ${missing.join(' and ')}.`),
    );
  } else {
    out.push(
      finding(
        'llms-txt-found',
        'info',
        'No llms.txt was found.',
        llms.verdict === null ? undefined : llms.verdict,
      ),
    );
  }

  const sitemap = site.sitemap;
  if (!sitemap.asked) {
    out.push(
      finding(
        'sitemap-valid',
        'info',
        `robots.txt keeps ${READER_TOKEN} from the sitemap, so it was not requested.`,
      ),
    );
  } else if (sitemap.facts !== null && sitemap.facts.outcome === 'valid') {
    const facts = sitemap.facts;
    out.push(
      finding(
        'sitemap-valid',
        'pass',
        `A valid sitemap${facts.kind === 'index' ? ' index' : ''} lists ${facts.locs} ${facts.kind === 'index' ? 'sitemap' : 'page'}${facts.locs === 1 ? '' : 's'}.`,
        sitemap.url ?? undefined,
      ),
    );
    if (facts.truncated) {
      out.push(
        finding(
          'sitemap-cut',
          'info',
          'The sitemap is larger than 5 MiB; it is valid as far as it was read.',
        ),
      );
    }
  } else {
    const reason = sitemap.facts?.reason;
    out.push(
      finding(
        'sitemap-valid',
        'warn',
        reason === undefined || reason === null
          ? 'No valid sitemap was found.'
          : `No valid sitemap: ${SITEMAP_REASON[reason]}.`,
        `${sitemap.url ?? ''}${sitemap.status === null ? '' : ` (status ${sitemap.status})`}`.trim(),
      ),
    );
  }
  return out;
}
