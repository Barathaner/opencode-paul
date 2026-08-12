#!/usr/bin/env node
//
// uninstall-paul — Remove all PAUL traces from this machine.
//
// Run with --yes to actually delete; without it, shows what WOULD be deleted.
//
// This is a Node.js wrapper that calls the bash script. It's distributed as
// an npm bin entry so users can run: npx opencode-paul-uninstall
//

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const scriptPath = join(__dirname, 'uninstall-paul.sh');

const args = process.argv.slice(2);
const child = spawn('bash', [scriptPath, ...args], {
  stdio: 'inherit',
  env: { ...process.env }
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
