// Opt-in #99 comparison harness (not part of npm test). Commands:
//   verify-dataset   --dataset-root DIR --expected-combined-sha256 HEX
//   freeze-snapshot  --dataset-root DIR --dataset-name NAME --expected-combined-sha256 HEX --out SNAPSHOT_JSON
//   run              --dataset-root DIR --snapshot SNAPSHOT_JSON --snapshot-sha256 HEX --configs C|M,C,A --runs N
//                    --out NEW_DIR --electron ELECTRON_EXE --playwright PLAYWRIGHT_INDEX_MJS
//                    [--anchors ANCHORS_JSON --baseline C_RESULTS_JSON]   (both required when A is listed)
//   seal-anchors     --results C_RESULTS_JSON --snapshot SNAPSHOT_JSON --snapshot-sha256 HEX --out ANCHORS_JSON
//   report           --results RESULTS_JSON --snapshot SNAPSHOT_JSON --snapshot-sha256 HEX --out REPORT_JSON
//   evaluate         --baseline C_RESULTS_JSON --anchors ANCHORS_JSON --candidates RESULTS_JSON
//                    --snapshot SNAPSHOT_JSON --snapshot-sha256 HEX --out GATES_JSON
//   select           --gates GATES_JSON --gates GATES_JSON --out DECISION_JSON
//   smoke-write-failure --dataset-root DIR --snapshot SNAPSHOT_JSON --snapshot-sha256 HEX --out NEW_DIR
//                    --electron ELECTRON_EXE --playwright PLAYWRIGHT_INDEX_MJS
// The snapshot SHA-256 must come from an external record (for held-out data, the custodian's seal).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDataset, sha256 } from './frontmatter-benchmark/dataset.mjs';
import { implementationHash, importForNode, runLive, smokeWriteFailure } from './frontmatter-benchmark/live.mjs';
import { CONFIGS, auditReport, completeRuns, evaluateDataset, sealAnchors, selectOutcome, verifyAnchors } from './frontmatter-benchmark/metrics.mjs';
import { bindDataset, buildSnapshot, readSnapshot, snapshotBinding } from './frontmatter-benchmark/snapshot.mjs';

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`Invalid argument near ${key}.`);
    const name = key.slice(2);
    options[name] = name === 'gates' ? [...(options[name] ?? []), value] : value;
  }
  return options;
}

function required(options, ...names) {
  for (const name of names) if (!options[name]) throw new Error(`--${name} is required.`);
}

async function readJson(file) {
  const bytes = await readFile(file);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

async function writeNew(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(file, text, { flag: 'wx' });
  return sha256(text);
}

/** Binding shared by runs, anchors and gate reports: frozen snapshot digests plus the implementation hash. */
async function currentBinding(snapshot) {
  const implementation = await implementationHash();
  return { binding: { ...snapshotBinding(snapshot), implementationSha256: implementation.sha256 }, implementation };
}

/** Loads results.json and every raw run file it lists, verifying each file's SHA-256. */
async function loadResults(file) {
  const results = await readJson(file);
  const runs = [];
  for (const reference of results.value.runs) {
    const bytes = await readFile(path.join(path.dirname(file), reference.file));
    if (sha256(bytes) !== reference.sha256) throw new Error(`Run file ${reference.file} does not match its recorded SHA-256.`);
    runs.push(JSON.parse(bytes.toString('utf8')));
  }
  return { ...results.value, runs };
}

async function boundDataset(options) {
  const snapshot = await readSnapshot(options.snapshot, options['snapshot-sha256']);
  const dataset = await loadDataset(options['dataset-root'], snapshot.inputs.combinedLoaderSha256);
  const { chunkMarkdown } = await importForNode('src/core/index/markdown-chunker.ts');
  return { snapshot, inputs: bindDataset(snapshot, dataset, chunkMarkdown) };
}

const [command, ...rest] = process.argv.slice(2);
const options = parseOptions(rest);

if (command === 'verify-dataset') {
  required(options, 'dataset-root', 'expected-combined-sha256');
  const dataset = await loadDataset(options['dataset-root'], options['expected-combined-sha256']);
  const groups = Object.fromEntries([...new Set(dataset.questions.map((question) => question.group))]
    .map((group) => [group, dataset.questions.filter((question) => question.group === group).length]));
  console.log(JSON.stringify({ notes: dataset.notes.length, questions: dataset.questions.length, groups,
    updateNotes: dataset.updates.notes, digests: dataset.digests }, null, 2));
} else if (command === 'freeze-snapshot') {
  required(options, 'dataset-root', 'dataset-name', 'expected-combined-sha256', 'out');
  const dataset = await loadDataset(options['dataset-root'], options['expected-combined-sha256']);
  const { chunkMarkdown } = await importForNode('src/core/index/markdown-chunker.ts');
  const fileSha256 = await writeNew(options.out, buildSnapshot(options['dataset-name'], dataset, chunkMarkdown));
  console.log(JSON.stringify({ snapshot: options.out, sha256: fileSha256,
    note: 'Record this SHA-256 outside the harness before the first C run; pass it as --snapshot-sha256.' }));
} else if (command === 'run') {
  required(options, 'dataset-root', 'snapshot', 'snapshot-sha256', 'configs', 'runs', 'out', 'electron', 'playwright');
  const configs = options.configs.split(',');
  if (configs.length === 0 || new Set(configs).size !== configs.length || configs.some((config) => !CONFIGS.includes(config))) {
    throw new Error('--configs must list distinct values from M, C, A.');
  }
  const runs = Number(options.runs);
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs needs a positive integer.');
  if (configs.includes('A')) required(options, 'anchors', 'baseline');
  const { snapshot, inputs } = await boundDataset(options);
  const { binding, implementation } = await currentBinding(snapshot);
  let anchors;
  if (configs.includes('A')) {
    // Candidates are measured only after five C runs have sealed the anchors; before any inference the anchors
    // are re-sealed from that exact baseline file and must match in full.
    const file = await readJson(options.anchors);
    const baselineFile = await readJson(options.baseline);
    if (file.value.cResultsSha256 !== baselineFile.sha256) throw new Error('Anchors were not sealed from this baseline file.');
    const baseline = await loadResults(options.baseline);
    if (baseline.parity?.pass !== true) throw new Error('The baseline C runs have no passing tokenizer parity record.');
    verifyAnchors(file.value, baseline.runs, snapshot, binding);
    anchors = { ...file.value, fileSha256: file.sha256 };
  }
  const results = await runLive({ inputs: { ...inputs, binding }, implementation, configs, runs, out: options.out,
    electronPath: options.electron, playwrightEntry: options.playwright, anchors });
  console.log(JSON.stringify({ out: options.out, runs: results.runs.length, binding }));
} else if (command === 'seal-anchors') {
  required(options, 'results', 'snapshot', 'snapshot-sha256', 'out');
  const snapshot = await readSnapshot(options.snapshot, options['snapshot-sha256']);
  const { binding } = await currentBinding(snapshot);
  const results = await loadResults(options.results);
  const resultsSha256 = (await readJson(options.results)).sha256;
  if (results.configs?.some((config) => !CONFIGS.includes(config))) throw new Error('Unknown results config.');
  if (JSON.stringify(results.binding) !== JSON.stringify(binding)) throw new Error('C results are bound to another snapshot or implementation.');
  if (results.parity?.pass !== true) throw new Error('The C runs have no passing tokenizer parity record.');
  const anchors = { ...sealAnchors(results.runs, snapshot, binding), cResultsSha256: resultsSha256,
    cRunFiles: results.runs.length, sealedAt: new Date().toISOString() };
  await writeNew(options.out, anchors);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(anchors.groups).map(([group, item]) => [group, { n: item.n, m: item.m }]))));
} else if (command === 'report') {
  required(options, 'results', 'snapshot', 'snapshot-sha256', 'out');
  const snapshot = await readSnapshot(options.snapshot, options['snapshot-sha256']);
  const results = await loadResults(options.results);
  if (!Array.isArray(results.configs) || results.configs.some((config) => !CONFIGS.includes(config))) {
    throw new Error('Unknown results config.');
  }
  const evidence = Object.fromEntries(results.configs.map((config) => [config, completeRuns(results.runs, config, snapshot, results.binding).problems]));
  await writeNew(options.out, { binding: results.binding, evidence, report: auditReport(results.runs, snapshot) });
  console.log(JSON.stringify({ out: options.out, evidence }));
} else if (command === 'evaluate') {
  required(options, 'baseline', 'anchors', 'candidates', 'snapshot', 'snapshot-sha256', 'out');
  const snapshot = await readSnapshot(options.snapshot, options['snapshot-sha256']);
  const { binding } = await currentBinding(snapshot);
  const baselineFile = await readJson(options.baseline);
  const anchors = await readJson(options.anchors);
  if (anchors.value.cResultsSha256 !== baselineFile.sha256) throw new Error('Anchors were not sealed from this baseline file.');
  const baseline = await loadResults(options.baseline);
  const candidatesFile = await readJson(options.candidates);
  const candidates = await loadResults(options.candidates);
  if (candidates.anchors?.sha256 !== anchors.sha256) throw new Error('Candidate runs did not use these anchors.');
  if (Date.parse(candidates.startedAt) <= Date.parse(anchors.value.sealedAt)) throw new Error('Candidate runs started before the anchors were sealed.');
  const report = { ...evaluateDataset({ snapshot, binding, anchors: anchors.value, baselineRuns: baseline.runs, sessionRuns: candidates.runs,
    parityPassed: baseline.parity?.pass === true && candidates.parity?.pass === true }),
  inputs: { baselineSha256: baselineFile.sha256, anchorsSha256: anchors.sha256, candidatesSha256: candidatesFile.sha256 },
  audit: { sealedC: auditReport(baseline.runs, snapshot), session: auditReport(candidates.runs, snapshot) } };
  await writeNew(options.out, report);
  console.log(JSON.stringify({ evidenceComplete: report.evidenceComplete,
    candidates: Object.fromEntries(Object.entries(report.candidates).map(([config, item]) => [config, item.status])) }));
} else if (command === 'select') {
  required(options, 'gates', 'out');
  const reports = [];
  for (const file of options.gates) reports.push((await readJson(file)).value);
  const decision = selectOutcome(reports);
  await writeNew(options.out, decision);
  console.log(JSON.stringify(decision));
} else if (command === 'smoke-write-failure') {
  required(options, 'dataset-root', 'snapshot', 'snapshot-sha256', 'out', 'electron', 'playwright');
  const { snapshot, inputs } = await boundDataset(options);
  const { binding } = await currentBinding(snapshot);
  const outcome = await smokeWriteFailure({ inputs: { ...inputs, binding }, electronPath: options.electron,
    playwrightEntry: options.playwright, out: options.out });
  console.log(JSON.stringify(outcome));
  if (!outcome.failedAsRequired) process.exitCode = 1;
} else {
  throw new Error('Usage: verify-dataset | freeze-snapshot | run | seal-anchors | report | evaluate | select | smoke-write-failure');
}
