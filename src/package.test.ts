import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRAWLERS, crawlersCoveredLine } from '@queryrev/ai-readiness';
import { describe, expect, it } from 'vitest';

// The package is published on its own, so these are checked here: what action.yml promises, what
// the README and the examples tell people to put in their workflows, that nothing reaches the
// network except in the two files meant to, and that no file carries internal text.

const root = fileURLToPath(new URL('..', import.meta.url));
const SLOW = 180_000;
const read = (name: string): string => readFileSync(join(root, name), 'utf8');

function filesUnder(
  folder: string,
  skip = ['node_modules', 'dist', '.turbo', 'coverage'],
): string[] {
  const out: string[] = [];
  for (const name of readdirSync(folder)) {
    if (skip.includes(name)) continue;
    const path = join(folder, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, skip));
    else out.push(path);
  }
  return out;
}

describe('action.yml', () => {
  const yml = read('action.yml');

  it('runs the bundled file on Node 24, with no pre or post step', () => {
    expect(yml).toMatch(/^runs:\n {2}using: node24\n {2}main: dist\/index\.js\n?$/m);
    expect(yml).not.toMatch(/^\s+(pre|post):/m);
  });

  it('names every input the code reads, with the documented defaults', () => {
    const block = yml.slice(yml.indexOf('inputs:'), yml.indexOf('outputs:'));
    const names = [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
    expect(names).toEqual([
      'robots-path',
      'llms-path',
      'check-paths',
      'base-ref',
      'fail-without-base',
      'comment',
      'github-token',
      'site-url',
      'site-fail-on',
    ]);
    expect(block).toContain('default: public/robots.txt');
    expect(block).toContain('default: public/llms.txt');
    expect(block).toContain("default: 'true'");
    expect(block).toMatch(/fail-without-base:[\s\S]*?default: 'false'/);
    expect(block).toContain('default: ${{ github.token }}');
    expect(block).toMatch(/site-url:[\s\S]*?default: ''/);
    expect(block).toMatch(/site-fail-on:[\s\S]*?default: never/);
    const readme = read('README.md');
    for (const name of names) expect(readme, name).toContain(`\`${name}\``);
  });

  it('has the branding the Marketplace asks for: a Feather icon and one of its colours', () => {
    const branding = /^branding:\n {2}icon: ([a-z-]+)\n {2}color: ([a-z-]+)$/m.exec(yml);
    expect(branding).not.toBeNull();
    // The colours the Marketplace accepts; the icon is checked against a list of Feather names
    // that includes the ones that suit a check, not the whole set.
    expect([
      'white',
      'black',
      'yellow',
      'blue',
      'green',
      'orange',
      'red',
      'purple',
      'gray-dark',
    ]).toContain(branding![2]);
    expect(['check-circle', 'check', 'shield', 'search', 'eye', 'file-text']).toContain(
      branding![1],
    );
    // Name, description and author are what the listing shows.
    expect(yml).toMatch(/^name: QueryRev AI Readiness$/m);
    expect(yml).toMatch(/^description: .{30,}$/m);
    expect(yml).toMatch(/^author: QueryRev$/m);
  });

  it('declares the two outputs', () => {
    expect(yml).toMatch(/outputs:\n {2}result:[\s\S]*?\n {2}failures:/);
  });
});

describe('the workflows people copy', () => {
  const workflows = filesUnder(join(root, 'examples')).filter((path) => /\.ya?ml$/.test(path));
  const readmeYaml = [...read('README.md').matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const all = [...workflows.map((path) => readFileSync(path, 'utf8')), ...readmeYaml];

  it('has examples', () => {
    expect(workflows.length).toBeGreaterThanOrEqual(2);
  });

  it('never use pull_request_target or a secret', () => {
    for (const text of all) {
      expect(text).not.toMatch(/pull_request_target/);
      expect(text).not.toMatch(/secrets\./);
    }
  });

  it('pin every action to a full commit SHA (this one: a placeholder for the release), @v1 only as the alternative', () => {
    for (const text of all) {
      // Lines that are comments show the alternative; the `uses:` lines that run are checked.
      const running = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      for (const match of running.matchAll(/uses:\s*(\S+)@(\S+)/g)) {
        if (match[1] === 'QueryRevAI/ai-readiness-action') {
          // The SHA of a release does not exist before the release: the README and the examples
          // carry a placeholder that the reader replaces.
          expect(match[2], match[0]).toMatch(/^([0-9a-f]{40}|<full-commit-sha>)$/);
        } else {
          expect(match[2], match[0]).toMatch(/^[0-9a-f]{40}$/);
        }
      }
    }
    // The README leads with the SHA form and shows @v1 as the convenient alternative.
    const readme = read('README.md');
    expect(readme).toMatch(/recommended form/);
    expect(readme.indexOf('@<full-commit-sha> # v1.0.0')).toBeGreaterThan(-1);
    expect(readme.indexOf('@<full-commit-sha> # v1.0.0')).toBeLessThan(
      readme.indexOf('ai-readiness-action@v1'),
    );
    expect(all.join('\n')).toContain(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    );
  });

  it('set the permissions the Action needs and no more', () => {
    for (const text of readmeYaml.filter((yaml) =>
      yaml.includes('QueryRevAI/ai-readiness-action'),
    )) {
      expect(text).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: write\n/);
      expect(text).not.toMatch(/write-all|contents: write|id-token/);
    }
    for (const path of workflows) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).toMatch(/permissions:\n {2}contents: read\n/);
      expect(text, path).not.toMatch(/contents: write|write-all/);
    }
  });

  it('check out with the history the comparison needs, and without keeping the token', () => {
    const pullRequest = readFileSync(join(root, 'examples', 'workflow.yml'), 'utf8');
    expect(pullRequest).toContain('fetch-depth: 0');
    expect(pullRequest).toContain('persist-credentials: false');
  });
});

describe('what the code may touch', () => {
  const sources = filesUnder(join(root, 'src')).filter(
    (path) => path.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(path),
  );
  const name = (path: string): string => relative(join(root, 'src'), path);

  it('calls the network only in github.ts (the comment) and online.ts (site-url)', () => {
    // The global fetch, in the one file that writes the comment.
    const comment = /\?\? fetch\b|(?<![.\w])fetch\(/;
    // The library's network layer, and Node's own, in the one file that runs the online check.
    const network = /from 'node:(?:https?|net|tls|dns|dgram|http2)'|checkSite|createTextFetcher/;
    const text = (path: string): string => readFileSync(path, 'utf8');
    expect(sources.filter((path) => comment.test(text(path))).map(name)).toEqual(['github.ts']);
    expect(sources.filter((path) => network.test(text(path))).map(name)).toEqual(['online.ts']);
  });

  it('loads the online check only through a dynamic import, and only from run.ts', () => {
    const importing = sources.filter((path) => /\.\/online'/.test(readFileSync(path, 'utf8')));
    expect(importing.map(name)).toEqual(['run.ts']);
    expect(readFileSync(join(root, 'src', 'run.ts'), 'utf8')).toMatch(
      /await import\('\.\/online'\)/,
    );
  });

  it('reads the environment only in main.ts, and PATH and HOME for git', () => {
    for (const path of sources) {
      const uses = [...readFileSync(path, 'utf8').matchAll(/process\.env(\[[^\]]*\])?/g)].map(
        (match) => match[0],
      );
      for (const use of uses) {
        const ok =
          name(path) === 'main.ts'
            ? use === 'process.env'
            : /^process\.env\['(PATH|HOME)'\]$/.test(use);
        expect(ok, `${name(path)}: ${use}`).toBe(true);
      }
    }
  });

  // The lint tool and its configuration belong to the repository the package is built in; the
  // published tree has neither, and the test is skipped there.
  it.skipIf(!existsSync(join(root, 'eslint.config.mjs')))(
    'refuses any other workspace package, and the library entries meant for a terminal or tests',
    async () => {
      // Loaded here, by a name the type checker does not follow, so a tree without eslint still
      // type-checks and loads this file.
      const tool = 'eslint';
      const { ESLint } = (await import(tool)) as {
        ESLint: new (options: { cwd: string }) => {
          lintText: (
            source: string,
            options: { filePath: string },
          ) => Promise<{ messages: { message: string }[] }[]>;
        };
      };
      const eslint = new ESLint({ cwd: root });
      const lint = async (source: string): Promise<string> => {
        const results = await eslint.lintText(source, { filePath: join(root, 'src', 'run.ts') });
        return (results[0]?.messages ?? []).map((message) => message.message).join('\n');
      };
      expect(await lint(`import { x } from '@queryrev/core';\nvoid x;\n`)).toContain(
        'no other workspace package',
      );
      expect(await lint(`import { x } from '@queryrev/ai-readiness/cli';\nvoid x;\n`)).toContain(
        'main entry only',
      );
      expect(
        await lint(`import { x } from '@queryrev/ai-readiness/testing';\nvoid x;\n`),
      ).toContain('main entry only');
      expect(await lint(`import { x } from '@queryrev/ai-readiness';\nvoid x;\n`)).toBe('');
    },
    SLOW,
  );
});

// Built from parts so this file does not contain what it looks for.
const forbidden: [string, RegExp][] = [
  ['a model provider name', new RegExp(['anthro', 'pic'].join(''), 'i')],
  ['a model name', new RegExp(['clau', 'de'].join(''), 'i')],
  ['an internal role', new RegExp(['found', 'er'].join(''), 'i')],
  ['an internal path', new RegExp(['docs', '/'].join(''))],
  ['a specification reference', /\bspec(?:ification)?\s+\d/i],
  [
    'a build-status word',
    new RegExp(
      `\\b(?:${[
        ['in ', 'development'],
        ['plan', 'ned'],
        ['coming ', 'soon'],
        ['be', 'ta'],
        ['mv', 'p'],
        ['early ', 'access'],
        ['work in ', 'progress'],
        ['under ', 'construction'],
      ]
        .map((parts) => parts.join(''))
        .join('|')})\\b`,
      'i',
    ),
  ],
  [
    'a claim about a client that is not shipped',
    new RegExp(['works with any M', 'CP client'].join(''), 'i'),
  ],
  [
    'an internal host',
    new RegExp(['rail', 'way|ver', 'cel|ing', 'est|ne', 'on\\.tech|sen', 'try'].join(''), 'i'),
  ],
  ['a block-everything template', /block all (?:the )?AI crawlers|all AI crawlers/i],
  ['a score', /\bscore\s*[:=]|\d+\s*\/\s*100\b|out of 100|\b(?:readiness|total) score\b/i],
];

function checkText(label: string, text: string): void {
  for (const [what, pattern] of forbidden) {
    // The README says "Nothing here says "all AI crawlers"": the one sentence that names the phrase.
    const scanned = text.replace(/Nothing here says "all AI crawlers"\./g, '');
    expect(pattern.test(scanned), `${label} contains ${what}`).toBe(false);
  }
}

describe('public text', () => {
  it('has no internal wording in any file of the folder', () => {
    for (const file of filesUnder(root)) {
      // The tests name the words they look for in their own regular expressions.
      if (file.endsWith('package.test.ts')) continue;
      // The lock file, written when the tree is built, lists other people's packages.
      if (file.endsWith('package-lock.json')) continue;
      checkText(relative(root, file), readFileSync(file, 'utf8'));
    }
  });

  it('has the licence, the security contact, and the crawlers line in the README', () => {
    expect(read('LICENSE')).toMatch(/^MIT License/);
    expect(read('SECURITY.md')).toContain('security@queryrev.com');
    expect(read('README.md')).toContain('security@queryrev.com');
    expect(read('README.md')).toContain(crawlersCoveredLine());
    for (const crawler of CRAWLERS) expect(read('README.md')).toContain(crawler.token);
    expect(read('README.md')).toContain('permissions:');
    expect(read('README.md')).toContain('contents: read');
    expect(read('README.md')).toContain('pull-requests: write');
  });

  it('is MIT, private, version 1.0.0, with the core as its one workspace dependency', () => {
    const manifest = JSON.parse(read('package.json')) as {
      license: string;
      private: boolean;
      version: string;
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest).toMatchObject({ license: 'MIT', private: true, version: '1.0.0' });
    expect(manifest.dependencies).toBeUndefined();
    // In the repository the core is a workspace package; in the exported tree it is the
    // vendored copy, linked as a file dependency.
    const workspace = Object.entries(manifest.devDependencies).filter(
      ([, range]) => range.startsWith('workspace:') || range === 'file:./vendor/ai-readiness',
    );
    expect(workspace.map(([dependency]) => dependency)).toEqual(['@queryrev/ai-readiness']);
  });
});

// The script that builds the published tree lives in the repository, not in the package: these
// tests run where it exists.
describe('the export of the Action', () => {
  const script = join(root, '..', '..', 'scripts', 'ai-readiness-export.mjs');
  const exported = (target: string, extra: string[] = ['--package', 'action']) =>
    spawnSync(process.execPath, [script, target, ...extra], { encoding: 'utf8' });

  it.skipIf(!existsSync(script))('refuses an unknown package', () => {
    const result = exported(join(tmpdir(), 'never-written-by-test'), ['--package', 'other']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });

  it.skipIf(!existsSync(script))(
    'writes the allowed files, the library source it is built on, and nothing private',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'action-export-'));
      try {
        const tree = join(parent, 'tree');
        // --skip-lockfile: no network, no install, no build (the export dry run does those).
        const result = exported(tree, ['--package', 'action', '--skip-lockfile']);
        expect(result.status, result.stderr).toBe(0);
        const top = readdirSync(tree).sort();
        expect(top).toEqual(
          [
            '.github',
            '.gitattributes',
            '.gitignore',
            'LICENSE',
            'README.md',
            'SECURITY.md',
            'action.yml',
            'examples',
            'package.json',
            'src',
            'tsconfig.json',
            'vendor',
            'vite.build.config.ts',
          ].sort(),
        );
        const files = filesUnder(tree, []).map((path) =>
          relative(tree, path).split('\\').join('/'),
        );
        expect(files).toContain('vendor/ai-readiness/src/index.ts');
        expect(files).toContain('vendor/ai-readiness/package.json');
        expect(files).toContain('src/main.ts');
        // Not vendored: the library's tests, test helpers and command line.
        expect(
          files.filter(
            (path) =>
              path.startsWith('vendor/') &&
              /\.test\.ts$|\.testkit\.ts$|\/cli\/|\/testing\/|net\/cli\.ts/.test(path),
          ),
        ).toEqual([]);
        // The built file is made from this tree by the export script (not run here: it needs
        // the network), never copied from the repository's own build.
        expect(files.some((path) => path.startsWith('dist/'))).toBe(false);
        // The workflow that rebuilds dist/ and fails when it differs from the committed one.
        expect(files).toContain('.github/workflows/ci.yml');
        const ci = readFileSync(join(tree, '.github', 'workflows', 'ci.yml'), 'utf8');
        expect(ci).toContain('npm run build');
        expect(ci).toMatch(/git status --porcelain -- dist/);
        expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
        expect(ci).not.toMatch(/secrets\.|id-token|contents: write/);
        for (const match of ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
          expect(match[1], match[0]).toMatch(/^[\w./-]+@[0-9a-f]{40}$/);
        }
        // dist/ is committed in this repository, so it is not ignored; the line endings of the
        // file are kept as they are built.
        const attributes = readFileSync(join(tree, '.gitattributes'), 'utf8');
        expect(attributes).toContain('eol=lf');
        expect(attributes).toContain('dist/** linguist-generated=true');
        expect(files.some((path) => /^\.env|node_modules|\.turbo|eslint\.config/.test(path))).toBe(
          false,
        );

        const manifest = readFileSync(join(tree, 'package.json'), 'utf8');
        expect(manifest).not.toMatch(/catalog:|workspace:/);
        expect(manifest).toContain('"@queryrev/ai-readiness": "file:./vendor/ai-readiness"');
        expect(manifest).not.toContain('"lint"');
        expect(readFileSync(join(tree, '.gitignore'), 'utf8')).not.toMatch(/^dist\/?$/m);

        for (const file of filesUnder(tree, [])) {
          if (/\.test\.ts$/.test(file)) continue;
          checkText(relative(tree, file), readFileSync(file, 'utf8'));
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it.skipIf(!existsSync(script))('refuses the repository and a folder that is not empty', () => {
    expect(exported(join(root, '..', '..')).status).toBe(2);
    expect(exported(root).status).toBe(2);
  });
});
