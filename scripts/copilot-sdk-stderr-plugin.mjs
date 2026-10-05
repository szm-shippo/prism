import { readFile } from 'node:fs/promises';

const COPILOT_SDK_SOURCE = /node_modules[\\/]@github[\\/]copilot-sdk[\\/]dist[\\/](?:cjs[\\/])?client\.js$/;
const STDERR_FORWARDER = /process\.stderr\.write\(`\[CLI subprocess\] \$\{line\}\r?\n`\);/g;
const PROCESS_FILE_LOGGING = /    if \(this\.options\.mode !== "empty"\) \{\r?\n      env\.COPILOT_RUNTIME_PROCESS_FILE_LOGGING = "1";\r?\n    \}/;

export function suppressCopilotCliDiagnosticsPlugin() {
  return {
    name: 'suppress-copilot-cli-diagnostics',
    setup(build) {
      build.onLoad({ filter: COPILOT_SDK_SOURCE }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const matches = source.match(STDERR_FORWARDER) ?? [];
        const fileLoggingMatches = source.match(PROCESS_FILE_LOGGING) ?? [];
        if (matches.length !== 1 || fileLoggingMatches.length !== 1) {
          throw new Error(`Expected one GitHub Copilot SDK 1.0.16 CLI diagnostics anchor; found ${matches.length} stderr and ${fileLoggingMatches.length} file-logging anchors.`);
        }
        return { contents: source.replace(STDERR_FORWARDER, '').replace(PROCESS_FILE_LOGGING, ''), loader: 'js' };
      });
    },
  };
}
