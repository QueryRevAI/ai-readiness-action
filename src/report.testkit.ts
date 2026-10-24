import { compareLlms } from './llms-rules';
import { compareRobots } from './robots-rules';

export function robotsFindingsFor(before: string, after: string) {
  const { rows, findings } = compareRobots(before, after, [], 'public/robots.txt');
  return { rows, findings };
}

export function llmsFindingsFor() {
  return compareLlms(
    '# Site\n\n> About.\n\n## Docs\n- [A](https://www.example.com/a)\n',
    '# Site\n\n> About.\n\n## Docs\n- [A](https://www.example.com/a)\n',
    'public/llms.txt',
  ).findings;
}
