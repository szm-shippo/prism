import { readFile } from 'node:fs/promises';

const COPILOT_SDK_SOURCE = /node_modules[\\/]@github[\\/]copilot-sdk[\\/]dist[\\/](?:cjs[\\/])?client\.js$/;
const STDERR_FORWARDER = /process\.stderr\.write\(`\[CLI subprocess\] \$\{line\}\r?\n`\);/g;

export function suppressCopilotCliStderrPlugin() {
  return {
    name: 'suppress-copilot-cli-stderr',
    setup(build) {
      build.onLoad({ filter: COPILOT_SDK_SOURCE }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const matches = source.match(STDERR_FORWARDER) ?? [];
        if (matches.length !== 1) {
          throw new Error(`Expected one GitHub Copilot SDK 1.0.16 CLI stderr forwarding anchor; found ${matches.length}.`);
        }
        return { contents: source.replace(STDERR_FORWARDER, ''), loader: 'js' };
      });
    },
  };
}
