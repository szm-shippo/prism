export function parseExcludedPaths(value: string): string[] {
  const paths = value.split(/\r?\n/u).map((line) => line.trim().replace(/\/$/u, '')).filter(Boolean);
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').some((part) =>
      part === '' || part === '.' || part === '..' || /[\\:\0\r\n]/u.test(part))) {
      throw new Error('Exclusions must be Vault-relative file or folder paths.');
    }
  }
  return [...new Set(paths)];
}

export function isExcludedPath(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((rule) => path === rule || path.startsWith(`${rule}/`));
}
