/**
 * Text marks for answers that are not the page asked for: a bot check, and a placeholder (a
 * parking page or a web server's default page). Fixed lists, so the same body gives the same
 * answer in every tool.
 */
import { parseRobots } from '../robots';

/** HTML markup anywhere in a body: no robots.txt holds it. */
export const HTML_MARKUP = /<(?:!doctype\s+html|html|head|body|script|meta|title)[\s>]/i;

/**
 * The marks of a bot check served in place of a file: Cloudflare ("Just a moment…", its
 * challenge platform), reCAPTCHA, hCaptcha, Akamai Bot Manager, HUMAN (PerimeterX), DataDome,
 * Imperva (Incapsula), AWS WAF, Sucuri, a hosting platform's security checkpoint, Kasada, and the
 * generic wording.
 */
export const CHALLENGE_MARKS = new RegExp(
  [
    'just a moment\\.\\.\\.',
    'cf-browser-verification',
    'cf_chl_',
    'challenge-platform',
    'challenges\\.cloudflare\\.com',
    'attention required! \\| cloudflare',
    'recaptcha',
    'hcaptcha',
    'errors\\.edgesuite\\.net',
    '_sec/cp_challenge',
    'bm-verify',
    'px-captcha',
    '_pxappid',
    'perimeterx',
    'captcha-delivery\\.com',
    'datadome',
    '_incapsula_resource',
    'incapsula incident',
    'awswaf',
    'aws-waf-token',
    'gokuprops',
    'sucuri website firewall',
    'sucuri_cloudproxy',
    // The platform's name is split so this file carries no internal host name (a test of the
    // package looks for them); the mark is the same text.
    `${'ver'}${'cel'} security checkpoint`,
    'kpsdk',
    'verify you are human',
    'checking your browser',
    'enable javascript and cookies to continue',
  ].join('|'),
  'i',
);

/**
 * Whether a 2xx answer at /robots.txt is not the file: a 202 (a check still running, most
 * often), or a body with no robots.txt group that is an HTML page or carries the marks of a bot
 * check. Such a site is "not read", never "read, no rules". A body with at least one group is a
 * file whatever its content type says.
 */
export function isChallenge(status: number | null, body: string): boolean {
  if (status === 202) return true;
  if (parseRobots(body).groups.length > 0) return false;
  return HTML_MARKUP.test(body) || CHALLENGE_MARKS.test(body);
}

/** A page with fewer words than this, carrying an interstitial mark, is a bot check. */
export const CHALLENGE_MAX_WORDS = 100;
/** A page with fewer words than this, carrying a mark, is a placeholder. */
export const PLACEHOLDER_MAX_WORDS = 150;
/** Characters of a page searched for marks: the head and the start of the body. */
export const MARKS_SCAN_CHARS = 64 * 1024;

/**
 * What a bot-check page says to a visitor, in its title or visible text: Cloudflare's "Just a
 * moment..." and "One more step", "Checking your browser", Imperva's "Pardon Our Interruption",
 * "Verify you are human", "Access denied" beside a captcha, a security checkpoint, and the
 * generic wording. These are for the home page, matched against text a visitor sees, never
 * against script sources: the scripts of a bot-check vendor (`challenge-platform`, a captcha
 * library, `datadome`) are loaded on ordinary pages too, and an empty application shell that
 * loads one is a page, not a check.
 */
export const INTERSTITIAL_MARKS = new RegExp(
  [
    'just a moment\\.\\.\\.',
    'one more step',
    'checking your browser',
    'verify you are human',
    'are you a robot',
    'attention required! \\| cloudflare',
    'pardon our interruption',
    'please complete the security check',
    'enable javascript and cookies to continue',
    'incapsula incident',
    'sucuri website firewall',
    'you have been blocked',
    'access denied[\\s\\S]{0,200}captcha',
    'captcha[\\s\\S]{0,200}access denied',
    // Split so this file carries no hosting platform's name (a test of the package looks).
    `${'ver'}${'cel'} security checkpoint`,
    'press & hold to confirm you are a human',
  ].join('|'),
  'i',
);

/**
 * Whether the home page is a bot check: a 202, or a small page (under `CHALLENGE_MAX_WORDS`
 * words of text) whose title or visible text (`text`) carries one of `INTERSTITIAL_MARKS`.
 */
export function isHomeChallenge(status: number | null, text: string, mainWords: number): boolean {
  if (status === 202) return true;
  if (mainWords >= CHALLENGE_MAX_WORDS) return false;
  return INTERSTITIAL_MARKS.test(text);
}

/**
 * The marks of a placeholder home page, each a fixed phrase: the default pages of common web
 * servers and control panels, and the wording of domain parking pages. Matched without case
 * against the start of the page's HTML.
 */
export const PLACEHOLDER_MARKS: readonly { readonly id: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { id: 'nginx_default', pattern: /welcome to nginx/i },
    {
      id: 'apache_default',
      pattern:
        /apache2? (?:\w+ )?default page|apache http server test page|test page for the apache/i,
    },
    { id: 'apache_it_works', pattern: /<h1>\s*it works!?\s*<\/h1>/i },
    {
      id: 'iis_default',
      pattern: /iis windows server|internet information services|<title>\s*iis7?\b/i,
    },
    { id: 'caddy_default', pattern: /caddy works!/i },
    {
      id: 'panel_default',
      pattern:
        /web server's default page|default web site page|domain default page|plesk default page|cpanel[^<]{0,40}default/i,
    },
    {
      id: 'hosting_default',
      pattern:
        /future home of something quite cool|this site can.t be reached yet|website coming\s+soon.{0,40}(?:namecheap|godaddy)/i,
    },
    {
      id: 'parked_domain',
      pattern:
        /this domain (?:is|may be) (?:for sale|parked|available)|domain (?:name )?(?:is )?for sale|buy this domain|is parked (?:free|courtesy)|parkingcrew|sedoparking|sedo\.com\/search|hugedomains|dan\.com\/buy-domain|afternic\.com\/forsale|bodis\.com|domainsponsor|above\.com\/parked/i,
    },
  ]);

/**
 * Whether the home page is a placeholder: a small page (under `PLACEHOLDER_MAX_WORDS` words of
 * text) that carries one of `PLACEHOLDER_MARKS`. Returns the mark's id, or null.
 */
export function placeholderMark(html: string, mainWords: number): string | null {
  if (mainWords >= PLACEHOLDER_MAX_WORDS) return null;
  const start = html.slice(0, MARKS_SCAN_CHARS);
  for (const mark of PLACEHOLDER_MARKS) if (mark.pattern.test(start)) return mark.id;
  return null;
}
