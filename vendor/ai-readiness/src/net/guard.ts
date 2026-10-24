import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { buildConnector } from 'undici';
import { classifyAddress, type AddressClass, type AddressRefusal } from './address';

/**
 * The network guard of a crawler. A crawler fetches URLs that come from the sites it reads
 * (links, sitemaps, redirects), so a URL can point anywhere, including at the machine it runs
 * on or its network: the cloud metadata address, a database on a private network, a service on
 * the loopback. The guard closes that door at three points:
 *
 * 1. Before a request, the URL itself: scheme `http` or `https`, port 80 or 443, no user
 *    name or password, and an IP-literal host must be an allowed address. The URL is parsed by
 *    the WHATWG parser, which turns decimal, octal, hexadecimal and shorthand IPv4 forms
 *    (`2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`) into the dotted quad before the check.
 * 2. At connection time, in the socket connector: the host name is resolved once, every
 *    address returned must be allowed (one refused address refuses the host), and the socket
 *    is opened to the address that was checked. Nothing resolves the name a second time, so a
 *    DNS answer that changes between check and connect (DNS rebinding) cannot slip through.
 * 3. Every redirect hop is a new request, so 1 and 2 apply to each hop (done by the fetcher that uses this guard).
 *
 * The guard is not configurable in production code: `createNetworkGuard` always uses the
 * strict rules. Tests reach a local fixture server through `createFixtureNetworkGuard` in the
 * package's testing entry point (`@queryrev/ai-readiness/testing`), which allows exactly one loopback address and one port.
 */

/** Ports the crawler connects to. */
export const CRAWL_PORTS: readonly number[] = Object.freeze([80, 443]);

/** Time allowed for one host-name lookup; past it the host counts as `dns_failed`. */
export const DNS_TIMEOUT_MS = 5_000;

/** Resolves a host name to its IP addresses (all of them, as `dns.lookup` with `all`). */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** The operating system's resolver, as a connection would use it. */
export const systemResolver: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, order: 'verbatim' });
  return answers.map((answer) => answer.address);
};

export type GuardErrorCode = 'refused_scheme' | 'refused_port' | 'refused_address' | 'dns_failed';

/** A request the guard refused, or a host name that did not resolve. The message is a code. */
export class NetworkGuardError extends Error {
  readonly code: GuardErrorCode;
  /** For `refused_address`: why the address is not allowed. */
  readonly reason: AddressRefusal | null;
  constructor(code: GuardErrorCode, reason: AddressRefusal | null = null) {
    super(reason === null ? `NetworkGuard: ${code}` : `NetworkGuard: ${code} (${reason})`);
    this.name = 'NetworkGuardError';
    this.code = code;
    this.reason = reason;
  }
}

export interface NetworkGuard {
  /** Checks a URL before it is requested. Throws NetworkGuardError when it is refused. */
  checkUrl(url: URL): void;
  /**
   * Resolves a host (a name or an IP literal, brackets allowed) and checks every address.
   * Returns the address to connect to. Throws NetworkGuardError.
   */
  vet(hostname: string, port: number): Promise<string>;
}

/** The rules a guard applies. Not exported from the package: production uses the strict set. */
export interface GuardRules {
  readonly ports: readonly number[];
  readonly classify: (address: string) => AddressClass;
}

export const STRICT_RULES: GuardRules = Object.freeze({
  ports: CRAWL_PORTS,
  classify: classifyAddress,
});

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function guardWithRules(
  rules: GuardRules,
  resolver: HostResolver,
  dnsTimeoutMs: number = DNS_TIMEOUT_MS,
): NetworkGuard {
  const checkAddress = (address: string): void => {
    const verdict = rules.classify(address);
    if (!verdict.allowed) throw new NetworkGuardError('refused_address', verdict.reason);
  };
  const checkPort = (port: number): void => {
    if (!rules.ports.includes(port)) throw new NetworkGuardError('refused_port');
  };
  return Object.freeze({
    checkUrl(url: URL): void {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new NetworkGuardError('refused_scheme');
      }
      // Credentials in a URL are never ours to send.
      if (url.username !== '' || url.password !== '') throw new NetworkGuardError('refused_scheme');
      const host = stripBrackets(url.hostname);
      if (isIP(host) !== 0) checkAddress(host);
      checkPort(url.port === '' ? defaultPort(url.protocol) : Number(url.port));
    },
    async vet(hostname: string, port: number): Promise<string> {
      checkPort(port);
      const host = stripBrackets(hostname);
      if (host === '') throw new NetworkGuardError('dns_failed');
      if (isIP(host) !== 0) {
        checkAddress(host);
        return host;
      }
      let addresses: readonly string[];
      let timer: NodeJS.Timeout | undefined;
      try {
        // A resolver that never answers must not hold a crawl step: the lookup is bounded.
        addresses = await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('dns_timeout')), dnsTimeoutMs);
          }),
        ]);
      } catch {
        throw new NetworkGuardError('dns_failed');
      } finally {
        clearTimeout(timer);
      }
      if (addresses.length === 0) throw new NetworkGuardError('dns_failed');
      // Every address must pass: a name that answers with one public and one private address
      // is refused, because which one a later connection gets is not ours to choose.
      for (const address of addresses) checkAddress(address);
      return stripBrackets(addresses[0]!);
    },
  });
}

/** The production guard: ports 80 and 443, public addresses only. */
export function createNetworkGuard(
  options: { readonly resolver?: HostResolver; readonly dnsTimeoutMs?: number } = {},
): NetworkGuard {
  return guardWithRules(
    STRICT_RULES,
    options.resolver ?? systemResolver,
    options.dnsTimeoutMs ?? DNS_TIMEOUT_MS,
  );
}

/**
 * An undici socket connector that vets every new connection through the guard and connects to
 * the vetted address. The `Host` header and the TLS server name still come from the URL (undici
 * derives both from the origin, not from the address it connects to), so certificates are
 * verified against the site's name.
 */
export function guardedConnector(
  guard: NetworkGuard,
  connectTimeoutMs: number,
  /**
   * Extra trusted CA certificates. Only the testing entry point passes one (the fixture's
   * self-signed certificate); production trusts Node's default CA store and nothing else.
   */
  testCa?: string,
): buildConnector.connector {
  const connect = buildConnector({
    timeout: connectTimeoutMs,
    allowH2: false,
    ...(testCa === undefined ? {} : { ca: testCa }),
  });
  return (options, callback) => {
    const port = options.port === '' ? defaultPort(options.protocol) : Number(options.port);
    guard.vet(options.hostname, port).then(
      (address) => connect({ ...options, hostname: address }, callback),
      (error: unknown) =>
        callback(error instanceof Error ? error : new NetworkGuardError('refused_address'), null),
    );
  };
}
