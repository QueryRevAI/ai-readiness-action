# QueryRev AI Readiness for GitHub Actions

A GitHub Action that stops a pull request from closing your site to AI search. It reads `robots.txt` and `llms.txt` from the checkout, compares them with the base of the pull request, and fails the job when the change:

- makes a crawler for AI search, or for fetching a page when a user asks, blocked (or newly partly blocked) at `/` or at paths you name; or
- breaks `llms.txt`: the file is removed, or is no longer an llms.txt under the soft-404 rule (an HTML page, a robots.txt, or text without a Markdown H1 is not one).

Training crawlers are reported and never fail the job: blocking them is the site's choice. Every result is a finding with its evidence, the deciding line of the file. There are no scores and no model calls.

It is offline by default. It reads files, and its only network call is the one pull request comment. An optional `site-url` also runs the online check of the live site.

## Use

```yaml
name: AI readiness

on:
  pull_request:
    paths:
      - public/robots.txt
      - public/llms.txt

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: QueryRevAI/ai-readiness-action@<full-commit-sha> # v1.0.1
        with:
          check-paths: |
            /blog/
            /pricing
```

Write the full commit SHA of the release you have read in place of `<full-commit-sha>`; the release page shows it. This is the recommended form: a commit SHA cannot be moved, and a tag can. The convenient alternative is `uses: QueryRevAI/ai-readiness-action@v1`, which follows each 1.x release automatically, at the price of trusting that the `v1` tag is only ever moved to code you would have accepted. `fetch-depth: 0` puts the base commit in the checkout; without it the Action stops and says so. The `paths` filter keeps the job to pull requests that touch one of the two files. More in `examples/`.

## Inputs

| Input               | Default               | What it does                                                                                                                                                    |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `robots-path`       | `public/robots.txt`   | The robots.txt in the checkout, relative to the repository root. It must stay inside the repository.                                                            |
| `llms-path`         | `public/llms.txt`     | The llms.txt in the checkout.                                                                                                                                   |
| `check-paths`       | none                  | URL paths to test besides `/`, one per line or comma separated, each starting with one `/`. At most 25.                                                         |
| `base-ref`          | the pull request base | A commit, branch or tag to compare with. On pull requests the default is the base commit of the pull request. Without a base, the files are judged as they are. |
| `fail-without-base` | `false`               | Without a base to compare with, a blocked crawler is a warning, because nothing got worse. Set `true` to fail the job on it.                                    |
| `comment`           | `true`                | On pull requests, write one comment and update it on every run.                                                                                                 |
| `github-token`      | `github.token`        | Used only to write and update that one comment.                                                                                                                 |
| `site-url`          | none                  | The live site, such as `https://www.example.com`. When set, the Action also runs the online check. Off by default.                                              |
| `site-fail-on`      | `never`               | What in the online check fails the job: `never`, `fail` or `warn`. The default is `never` because the live site may be what the pull request fixes.             |

Outputs: `result` (`pass` or `fail`) and `failures` (the number of failing findings).

## What fails and what does not

| Change                                                                                      | Result                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| An AI search or user-fetch crawler goes from allowed to partial or blocked at `/` or a path | fail                                            |
| An AI search or user-fetch crawler goes from partial to blocked                             | fail                                            |
| llms.txt was an llms.txt and is removed, or is no longer one                                | fail                                            |
| A training crawler changes in any direction                                                 | info, never a fail                              |
| A crawler was already blocked before the change                                             | info, not a new fail                            |
| llms.txt lacks a summary, an H2 section of links, or has more than one H1                   | warn                                            |
| No robots.txt or no llms.txt in the checkout                                                | info; a missing robots.txt allows every crawler |

Without a base to compare with (a `push` or scheduled run without `base-ref`), nothing "got worse", so a blocked or partly blocked search or user-fetch crawler is a warning. Set `fail-without-base: true` to fail the job on a blocked one.

The crawlers are judged as the `@queryrev/ai-readiness` library judges them, by the rules of RFC 9309: the group that names the crawler applies, else the `*` group; the longest matching rule wins and `Allow` wins a tie. A path that only `*` keeps from everyone (`/cart`, `/search`) is housekeeping, not a block.

## What you see

The report is written to the job summary and, on a pull request, to one comment that starts with a hidden marker. The next run finds its own comment by that marker and updates it, so a pull request never gets a second one. Only a comment written by the token's own identity is updated: the Actions bot (`github-actions[bot]`) for the default token, or the login the token reports for itself. A comment by anyone else that copies the marker is left alone. A failing finding is also an annotation on the line of the file that decides it.

```
## AI readiness check: failed

2 failing, 0 warnings. Compared with `HEAD`.

### What fails

- FAIL `crawler-access-regression` OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Amazonbot (search or user fetch) at / went from allowed to blocked. (`public/robots.txt` line 3): `Disallow: /`
...
Crawlers covered: the 11 AI crawlers on this list, from OpenAI, Perplexity, Google, Apple, Common Crawl, Meta, Amazon and ByteDance. Other crawlers are not checked.
```

`examples/robots-before.txt` and `examples/robots-after.txt` are a change that produces this report.

## Crawlers covered

Crawlers covered: the 11 AI crawlers on this list, from OpenAI, Perplexity, Google, Apple, Common Crawl, Meta, Amazon and ByteDance. Other crawlers are not checked.

| Crawler            | Vendor       | Purpose  |
| ------------------ | ------------ | -------- |
| GPTBot             | OpenAI       | training |
| OAI-SearchBot      | OpenAI       | search   |
| ChatGPT-User       | OpenAI       | user     |
| PerplexityBot      | Perplexity   | search   |
| Perplexity-User    | Perplexity   | user     |
| Google-Extended    | Google       | training |
| Applebot-Extended  | Apple        | training |
| CCBot              | Common Crawl | training |
| Meta-ExternalAgent | Meta         | training |
| Amazonbot          | Amazon       | search   |
| Bytespider         | ByteDance    | training |

Every report carries this line. Nothing here says "all AI crawlers".

## What it cannot see

It reads two files. It cannot see a CDN or firewall rule that answers AI crawlers differently from how robots.txt reads, what a crawler actually fetches, or whether a page is cited in an AI answer. A robots.txt that is generated at deploy time is not in the checkout; point `robots-path` at the file that is.

## Permissions and safety

```yaml
permissions:
  contents: read
  pull-requests: write
```

- **Use the `pull_request` event. The Action refuses to run on `pull_request_target`.** That event gives a job a write token and secrets while it reads files changed by whoever opened the pull request.
- **The token is used for the one comment, and for nothing else.** With `comment: false`, or outside a pull request, the token is not used. A pull request from a fork is recognised from the event (its head repository differs from the base) and gets no comment and no API call, only a warning; the report is in the job summary. If a token is refused anyway, the comment is skipped the same way.
- **Offline by default.** With `site-url` empty the Action makes no network call except that comment. It reads the base files with `git` from the commit that is already in the checkout.
- **Files from a pull request are not trusted.** Paths must stay inside the repository and resolve to a regular file (a symbolic link that points out is refused); files are read up to the library's caps (robots.txt 500 KiB, llms.txt 1 MiB); text from a file is stripped of control characters, cut short and shown only inside code spans, so markup, mentions and workflow commands in a file stay inert.
- **No telemetry.** Nothing is sent to queryrev.com or to anyone but the GitHub API (the comment) and, if you set `site-url`, the site you name.
- Pin the Action to a full commit SHA (a tag such as `v1` can be moved), and read the release before you update the pin.

### The online check

With `site-url` the Action runs the online check of the `@queryrev/ai-readiness` library against the live site: robots.txt first, then the home page, `/llms.txt` and the sitemap where robots.txt lets the check in. It follows the library's network rules: only `http` and `https`, ports 80 and 443, no IP-literal hosts, private, loopback and metadata addresses refused, at most 3 redirects, each checked again, size caps (robots.txt 500 KiB, llms.txt 1 MiB, pages 2 MiB, sitemaps 5 MiB), 5 seconds to connect, 10 seconds a request, 30 seconds in all, and one request a second to a host. Its user agent is `Mozilla/5.0 (compatible; QueryRev-AIReadiness/1.0; +https://queryrev.com/bot)`, and it obeys the rules written for `QueryRev-AIReadiness` or `*`.

## Build

The Action is one bundled file, `dist/index.js`, for the Node 24 runtime that GitHub provides. The bundle is made from `src/` and the `@queryrev/ai-readiness` library in `vendor/`. To build it yourself: `npm ci`, `npm run build` (the lock file is committed, so the same tree builds the same file).

## Licence

MIT, see `LICENSE`.

## Contributing

Issues and pull requests are welcome at https://github.com/QueryRevAI/ai-readiness-action. This repository is updated by release snapshots, so we apply an accepted change ourselves and credit you as a co-author on the commit; the next release carries it. A pull request is therefore closed with a note instead of being merged.

## Security

Report a vulnerability to **security@queryrev.com**, not in a public issue. See `SECURITY.md`.
