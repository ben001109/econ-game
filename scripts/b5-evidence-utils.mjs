import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_BUILD_EXCLUDES = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

export function isEnvBasename(name) {
  return name.startsWith('.env');
}

export function shouldExcludeEnvPath(pathname) {
  return pathname.split(/[\\/]+/u).some((part) => isEnvBasename(part));
}

function portableRelative(root, pathname) {
  return relative(root, pathname).split(sep).join('/');
}

export async function copyTreeExcludingEnv(sourceRoot, targetRoot, options = {}) {
  const buildExcludes = options.buildExcludes ?? DEFAULT_BUILD_EXCLUDES;
  const excludedEnvPaths = [];
  const excludedBuildPaths = [];

  async function visit(sourceDirectory, targetDirectory) {
    await mkdir(targetDirectory, { recursive: true });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name);
      const targetPath = join(targetDirectory, entry.name);
      const relativePath = portableRelative(sourceRoot, sourcePath);

      if (isEnvBasename(entry.name)) {
        excludedEnvPaths.push(relativePath);
        continue;
      }
      if (buildExcludes.has(entry.name)) {
        excludedBuildPaths.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to copy symlink while producing evidence: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported filesystem entry while producing evidence: ${relativePath}`);
      }
      await copyFile(sourcePath, targetPath);
    }
  }

  await visit(sourceRoot, targetRoot);
  return { excludedEnvPaths, excludedBuildPaths };
}

export async function listEnvPathNames(root) {
  const found = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const pathname = join(directory, entry.name);
      const relativePath = portableRelative(root, pathname);
      if (isEnvBasename(entry.name)) {
        found.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(pathname);
      }
    }
  }

  await visit(root);
  return found;
}

export function sanitizedCommandEnvironment() {
  const allowed = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USER',
  ];
  const environment = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  environment.CI = '1';
  environment.NEXT_TELEMETRY_DISABLED = '1';
  environment.npm_config_audit = 'false';
  environment.npm_config_fund = 'false';
  return environment;
}

export function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? sanitizedCommandEnvironment(),
  });
  return {
    command: [command, ...args],
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error?.message ?? null,
  };
}

export async function sha256File(pathname) {
  const content = await readFile(pathname);
  return createHash('sha256').update(content).digest('hex');
}

export async function fileIdentity(pathname) {
  const metadata = await stat(pathname);
  return {
    path: pathname,
    bytes: metadata.size,
    sha256: await sha256File(pathname),
  };
}

export function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

export function isMain(importMetaUrl) {
  return process.argv[1] !== undefined && importMetaUrl === new URL(`file://${process.argv[1]}`).href;
}
