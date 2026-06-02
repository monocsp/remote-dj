#!/usr/bin/env node
import { execSync } from 'node:child_process';
// Stop hook: gate the turn on a clean typecheck when TypeScript files changed.
// - Loop guard: if we're already in a stop-hook continuation, do nothing.
// - Cheap skip: only run when .ts/.tsx files are dirty (skips chat-only turns).
// - On failure: emit a `block` decision so Claude fixes the errors, then stops.
// Node-only (no jq) for macOS / Linux / Termux parity.
import { readFileSync } from 'node:fs';

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

// Loop guard — never re-trigger ourselves.
if (payload?.stop_hook_active) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Only bother when TypeScript actually changed this turn.
let dirty = '';
try {
  dirty = execSync('git status --porcelain', { cwd }).toString();
} catch {
  process.exit(0);
}
const tsChanged = dirty.split('\n').some((line) => /\.(ts|tsx)\s*$/.test(line));
if (!tsChanged) process.exit(0);

try {
  execSync('npm run typecheck', { cwd, stdio: 'pipe' });
  process.exit(0);
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  const lines = out.split('\n').filter((l) => /error TS|\.tsx?[:(]/.test(l));
  const reason = (lines.slice(-20).join('\n') || out.slice(-1500)).trim();
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `Typecheck failed — fix these TypeScript errors before finishing:\n${reason}`,
    }),
  );
  process.exit(0);
}
