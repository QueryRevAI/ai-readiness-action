/**
 * A registrable domain without a public-suffix list. The library keeps one runtime dependency,
 * so the built-in rule is small: the last two labels, or the last three when the last two are a
 * common second-level suffix (`co.uk`, `com.au`). A caller that needs the full list passes its
 * own function (`CheckOptions.registrableDomain`, `ReadHomePageOptions.registrableDomain`).
 */

const SECOND_LEVEL = new Set(
  [
    'co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk',
    'com.au net.au org.au edu.au gov.au id.au asn.au',
    'co.nz net.nz org.nz govt.nz ac.nz',
    'co.jp ne.jp or.jp ac.jp go.jp ad.jp ed.jp gr.jp',
    'co.kr or.kr ne.kr go.kr ac.kr',
    'com.cn net.cn org.cn gov.cn edu.cn',
    'com.hk org.hk net.hk edu.hk gov.hk',
    'com.tw org.tw net.tw edu.tw gov.tw',
    'com.sg org.sg net.sg edu.sg gov.sg',
    'com.my org.my net.my edu.my gov.my',
    'com.vn net.vn org.vn edu.vn gov.vn',
    'co.th or.th ac.th go.th in.th',
    'co.id or.id ac.id go.id web.id',
    'com.ph org.ph net.ph edu.ph gov.ph',
    'com.pk org.pk net.pk edu.pk gov.pk',
    'com.bd org.bd net.bd edu.bd gov.bd',
    'co.in net.in org.in ac.in gov.in edu.in firm.in gen.in ind.in',
    'co.il org.il ac.il gov.il net.il',
    'co.za org.za ac.za gov.za net.za web.za',
    'com.br net.br org.br gov.br edu.br',
    'com.ar net.ar org.ar gov.ar edu.ar',
    'com.mx org.mx net.mx gob.mx edu.mx',
    'com.co net.co org.co edu.co gov.co',
    'com.pe com.ve com.uy com.ec com.bo com.py com.pa com.gt com.do',
    'com.tr net.tr org.tr gov.tr edu.tr',
    'com.ua org.ua net.ua gov.ua edu.ua',
    'com.sa org.sa net.sa gov.sa edu.sa',
    'com.eg org.eg net.eg gov.eg edu.eg',
    'com.ng org.ng net.ng gov.ng edu.ng',
    'co.ke or.ke ac.ke go.ke',
    'com.gh com.tn com.dz com.ma co.ma',
    'com.ru net.ru org.ru',
    'com.pl net.pl org.pl',
    'com.es org.es nom.es',
    'com.pt org.pt',
    'com.gr org.gr',
    'com.cy org.cy',
    'com.lk com.np com.kh com.mm com.kz',
  ]
    .join(' ')
    .split(' '),
);

/** A host name as comparisons use it: lower case, without one trailing dot. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * The registrable domain of a host name (`www.shop.example.co.uk` → `example.co.uk`). A name
 * with one label, or an IP literal, is returned as it is.
 */
export function registrableDomain(host: string): string {
  const name = normalizeHost(host);
  // An IP literal has no registrable domain.
  if (name.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return name;
  const labels = name.split('.');
  if (labels.length <= 2) return name;
  const lastTwo = labels.slice(-2).join('.');
  if (SECOND_LEVEL.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

/** Whether `host` is the registrable domain `domain` or a name under it. */
export function isOnDomain(host: string, domain: string): boolean {
  const name = normalizeHost(host);
  return name === domain || name.endsWith(`.${domain}`);
}
