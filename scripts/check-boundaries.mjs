import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoot = path.join(projectRoot, 'src');

function relativeSourcePath(filePath) {
  return path.relative(sourceRoot, filePath).split(path.sep).join('/');
}

export function boundaryViolations(filePath, source) {
  const relativePath = relativeSourcePath(filePath);
  const inCore = relativePath.startsWith('core/');
  const inPresentation = relativePath.startsWith('presentation/');
  if (!inCore && !inPresentation) return [];

  const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const violations = [];

  function checkImport(specifier, position) {
    if (specifier === 'obsidian' || specifier.startsWith('obsidian/')) {
      violations.push(`${relativePath}:${position}: Obsidian API is restricted to src/obsidian`);
      return;
    }
    if (!specifier.startsWith('.')) return;

    const target = relativeSourcePath(path.resolve(path.dirname(filePath), specifier));
    if (target.startsWith('obsidian/') || (inCore && target.startsWith('presentation/'))) {
      violations.push(`${relativePath}:${position}: ${specifier} crosses into an outer layer`);
    }
    if ((relativePath.startsWith('core/index/') || relativePath.startsWith('core/provider/'))
      && target.startsWith('core/application/')) {
      violations.push(`${relativePath}:${position}: ${specifier} makes a lower layer depend on application`);
    }
  }

  function visit(node) {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (ts.isCallExpression(node) && node.arguments.length === 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifier = node.arguments[0];
    }

    if (specifier && ts.isStringLiteral(specifier)) {
      const position = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      checkImport(specifier.text, position);
    }
    ts.forEachChild(node, visit);
  }

  visit(tree);
  return violations;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await sourceFiles(sourceRoot);
  const violations = (await Promise.all(files.map(async (file) =>
    boundaryViolations(file, await readFile(file, 'utf8'))))).flat();
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  }
}
