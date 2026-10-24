import { COMMENT_MARKER } from './github';

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: 'Bot' | 'User' };
}

/** An in-memory GitHub issue-comments API that records every request. */
export function fakeGitHub(
  initial: FakeComment[] = [],
  options: {
    patchStatusFor?: Record<number, number>;
    postStatus?: number;
    /** Who GET /user answers with; by default it is refused, as for the default token. */
    me?: { login: string; type: 'User' | 'Bot' };
  } = {},
) {
  const comments = [...initial];
  const requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];
  let nextId = 1000;
  const reply = (status: number, json: unknown = {}): Response =>
    new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

  const fetchFake: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    requests.push({
      method,
      url,
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const parsed = new URL(url);
    if (method === 'GET' && parsed.pathname === '/user') {
      return Promise.resolve(options.me ? reply(200, options.me) : reply(403));
    }
    const patch = /\/issues\/comments\/(\d+)$/.exec(parsed.pathname);
    if (method === 'GET') {
      const page = Number(parsed.searchParams.get('page') ?? '1');
      const per = Number(parsed.searchParams.get('per_page') ?? '30');
      return Promise.resolve(reply(200, comments.slice((page - 1) * per, page * per)));
    }
    if (method === 'PATCH' && patch) {
      const id = Number(patch[1]);
      const status = options.patchStatusFor?.[id];
      if (status !== undefined && status !== 200) return Promise.resolve(reply(status));
      const found = comments.find((comment) => comment.id === id);
      if (!found) return Promise.resolve(reply(404));
      found.body = (JSON.parse(bodyOf(init)) as { body: string }).body;
      return Promise.resolve(reply(200, found));
    }
    if (method === 'POST') {
      if (options.postStatus !== undefined && options.postStatus !== 201) {
        return Promise.resolve(reply(options.postStatus));
      }
      const created: FakeComment = {
        id: nextId++,
        body: (JSON.parse(bodyOf(init)) as { body: string }).body,
        user: options.me ?? { login: 'github-actions[bot]', type: 'Bot' },
      };
      comments.push(created);
      return Promise.resolve(reply(201, created));
    }
    return Promise.resolve(reply(405));
  };
  return { fetch: fetchFake, comments, requests };
}

const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '{}';

export const withMarker = (text: string): string => `${COMMENT_MARKER}\n${text}`;
