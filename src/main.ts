import { run } from './run';

// The entry point of the Action (`dist/index.js`).
const code = await run({ env: process.env });
process.exitCode = code;
