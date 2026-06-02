#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
// PostToolUse hook: format the just-edited file with Biome.
// Non-blocking by design — formatting is applied, but unfixable lint never
// blocks an edit (lint/typecheck are gated at Stop + in CI instead).
// Reads the hook payload as JSON on stdin; uses Node only (no jq) so it runs
// the same on macOS, Linux, and Termux.
import { readFileSync } from 'node:fs';

const FORMATTABLE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'css']);

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const file = payload?.tool_input?.file_path;
if (!file) process.exit(0);

const ext = file.split('.').pop()?.toLowerCase();
if (!ext || !FORMATTABLE.has(ext)) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try {
  execFileSync('npx', ['@biomejs/biome', 'check', '--write', file], {
    cwd,
    stdio: 'ignore',
  });
} catch {
  // Biome exits non-zero when lint issues remain unfixed; the formatting
  // edits are still written. Do not block the edit on that.
}
process.exit(0);
