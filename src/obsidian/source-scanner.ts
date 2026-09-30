import type { Vault } from 'obsidian';

/** Returns Vault-relative paths of the Markdown files currently known to Obsidian. */
export function scanMarkdownSourcePaths(vault: Pick<Vault, 'getMarkdownFiles'>): string[] {
  return vault.getMarkdownFiles().map((file) => file.path);
}
