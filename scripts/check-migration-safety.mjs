#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['.github', 'scripts', 'services', 'pterodactyl'];
const rootFiles = ['docker-compose.yml', 'docker-compose.python.yml'];
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules', '.next']);
const executableExtensions = new Set(['.json', '.mjs', '.js', '.cjs', '.sh', '.yml', '.yaml']);
const executableNames = new Set(['Dockerfile', 'Dockerfile.bun', 'package.json']);
const forbiddenSchemaPush = new RegExp(
  String.raw`(?:npx|bunx|pnpm\s+exec|npm\s+exec)?\s*prisma\s+db\s+push\b|["']db:push["']\s*:`,
  'i',
);

function collect(path) {
  const name = basename(path);
  if (ignoredDirectories.has(name) || name.startsWith('.env')) return [];

  const stats = statSync(path);
  if (stats.isDirectory()) {
    return readdirSync(path).flatMap((entry) => collect(join(path, entry)));
  }

  if (executableNames.has(name) || executableExtensions.has(extname(name))) return [path];
  return [];
}

const candidates = [
  ...rootFiles.map((path) => resolve(repositoryRoot, path)),
  ...roots.flatMap((path) => collect(resolve(repositoryRoot, path))),
];

const violations = [];
for (const path of candidates) {
  const content = readFileSync(path, 'utf8');
  content.split(/\r?\n/u).forEach((line, index) => {
    if (forbiddenSchemaPush.test(line)) {
      violations.push(`${relative(repositoryRoot, path)}:${index + 1}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Forbidden schema-push command found. Use reviewed migrations and a separate deploy step:');
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Migration safety scan passed (${candidates.length} executable/config files checked).`);
}
