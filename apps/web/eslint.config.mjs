// ESLint flat config — owns the React-Hooks + Next.js (core-web-vitals) rules
// that Biome doesn't fully cover. Biome handles formatting + general lint for
// the rest of the monorepo; ESLint runs only here in apps/web.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends('next/core-web-vitals'),
  { ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts'] },
];

export default config;
