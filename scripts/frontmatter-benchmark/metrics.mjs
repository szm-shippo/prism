// Frozen #99 metrics and acceptance gates. Every metric is recomputed from raw ranked hits; stored summaries are
// only accepted when they equal the recomputation. Missing or inconsistent evidence is BLOCKED, never FAIL.
export const STAGES = ['vector', 'hybrid', 'rerank'];
export const GROUPS = ['attribute', 'body', 'similar', 'plain'];
export const CONFIGS = ['M', 'C', 'A'];
export const UPDATE_SCENARIOS = ['nonTargetFrontmatter', 'indexedAttribute', 'body'];
export const REQUIRED_RUNS = 5;
export const MIN_GROUP_QUESTIONS = 12;
const MAX_MODEL_TOKENS = 512;
const STAGE_LIMITS = { vector: 20, hybrid: 20, rerank: 6 };

export const gain2 = (n) => Math.ceil((2 * n) / 12);
export const loss1 = (n) => Math.floor(n / 12);

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function spread(values) {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values), values: [...values] };
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

/** Exact-gold metrics for one ranked list (top first). */
export function questionMetrics(ranked, gold) {
  const goldRank = ranked.findIndex((hit) => hit.chunkId === gold.chunkId) + 1 || null;
  const firstGoldSource = ranked.slice(0, 6).find((hit) => hit.sourceId === gold.sourceId);
  return {
    goldRank,
    recallAt1: goldRank !== null && goldRank <= 1,
    recallAt3: goldRank !== null && goldRank <= 3,
    recallAt6: goldRank !== null && goldRank <= 6,
    noResult: ranked.length === 0,
    wrongNoteTop1: ranked.length > 0 && ranked[0].sourceId !== gold.sourceId,
    wrongNoteTop3Slots: ranked.slice(0, 3).filter((hit) => hit.sourceId !== gold.sourceId).length,
    goldSourceInTop6: Boolean(firstGoldSource),
    firstGoldSourceChunkTop6: firstGoldSource?.chunkId ?? null,
    sectionFirstAt6: firstGoldSource?.chunkId === gold.chunkId,
  };
}

export function recomputeQuestion(question) {
  return Object.fromEntries(STAGES.map((stage) => [stage, questionMetrics(question.stages[stage], question.gold)]));
}

/** Per-group and overall counts for one run. Overall Section Top-1 is final-stage exact-gold R@1. */
export function summarizeRun(questions) {
  const groups = ['all', ...new Set(questions.map((question) => question.group))];
  const metrics = questions.map((question) => ({ group: question.group, metrics: recomputeQuestion(question) }));
  return Object.fromEntries(groups.map((group) => {
    const selected = metrics.filter((item) => group === 'all' || item.group === group);
    const stages = Object.fromEntries(STAGES.map((stage) => {
      const count = (key) => selected.reduce((total, item) => total + Number(item.metrics[stage][key]), 0);
      return [stage, { recallAt1: count('recallAt1'), recallAt3: count('recallAt3'), recallAt6: count('recallAt6'),
        noResult: count('noResult'), wrongNoteTop1: count('wrongNoteTop1'), wrongNoteTop3Slots: count('wrongNoteTop3Slots'),
        goldSourceInTop6: count('goldSourceInTop6') }];
    }));
    stages.rerank.sectionTop1 = stages.rerank.recallAt1;
    return [group, { questions: selected.length, ...stages }];
  }));
}

function hasUnknownInputKind(run) {
  const kinds = run.config === 'A' ? ['body', 'attribute-chunk'] : ['body'];
  const unknownKeys = (record) => record && Object.keys(record).some((key) => !kinds.includes(key));
  return run.build?.inputs?.some((input) => !kinds.includes(input?.kind)) ||
    unknownKeys(run.build?.vectorCounts) || UPDATE_SCENARIOS.some((scenario) => {
      const update = run.updates?.[scenario];
      return unknownKeys(update?.vectorCounts) || unknownKeys(update?.inferencesByKind) ||
        update?.reports?.some((report) => unknownKeys(report?.inferences));
    });
}

/**
 * Structural and identity checks of one raw run against the frozen snapshot: binding digests, question order,
 * text and gold, hits that name real snapshot chunks of the right source, stage lengths, and stored summaries
 * that equal the recomputation. Returns a list of problems (empty when valid).
 */
export function validateRun(run, snapshot, binding) {
  const problems = [];
  if (!CONFIGS.includes(run?.config) || !Number.isSafeInteger(run?.run)) return ['run record has no valid config/run number'];
  if (hasUnknownInputKind(run)) problems.push('run has an unknown input kind');
  if (JSON.stringify(run.binding) !== JSON.stringify(binding)) problems.push('snapshot binding differs');
  if (!run.build || typeof run.build !== 'object' || Array.isArray(run.build)) problems.push('build record missing');
  const questions = run.queries?.questions;
  if (!Array.isArray(questions) || questions.length !== snapshot.questions.length) return [...problems, 'question records missing'];
  const chunkSource = new Map(snapshot.chunks.map((chunk) => [chunk.chunk_id, chunk.source_id]));
  questions.forEach((question, index) => {
    const expected = snapshot.questions[index];
    const gold = snapshot.gold[index];
    if (question?.id !== expected.id || question.group !== expected.group || question.question !== expected.question) {
      problems.push(`question ${index + 1} differs from the snapshot`);
      return;
    }
    if (['sourceId', 'chunkId', 'startLine', 'endLine'].some((key) => question.gold?.[key] !== gold[key])) {
      problems.push(`gold of ${question.id} differs from the snapshot`);
    }
    for (const stage of STAGES) {
      const hits = question.stages?.[stage];
      if (!Array.isArray(hits) || (run.config !== 'M' || stage !== 'vector') && hits.length > STAGE_LIMITS[stage] ||
          hits.some((hit) => !hit || chunkSource.get(hit.chunkId) !== hit.sourceId) ||
          new Set(hits.map((hit) => hit.chunkId)).size !== hits.length) {
        problems.push(`${stage} hits of ${question.id} are malformed`);
      }
    }
    if (question.metrics !== undefined && problems.length === 0 &&
        JSON.stringify(question.metrics) !== JSON.stringify(recomputeQuestion(question))) {
      problems.push(`stored metrics of ${question.id} differ from its rankings`);
    }
  });
  if (problems.length === 0 && run.summary !== undefined && JSON.stringify(run.summary) !== JSON.stringify(summarizeRun(questions))) {
    problems.push('stored summary differs from the rankings');
  }
  return problems;
}

/**
 * Hard invariants every M/C control run must satisfy before it can seal anchors or count as complete evidence:
 * privacy, registry integrity, persistence readback and captured delivered inputs. C must also keep every input
 * within 512 tokens; M deliberately embeds uncapped raw chunks, so only its delivery capture is required.
 */
export function controlProblems(run, config) {
  const problems = [];
  const privacy = privacyCheck(run);
  if (privacy) problems.push(`privacy: ${privacy === 'BLOCKED' ? 'offline, monitor or probe evidence missing' : privacy}`);
  const integrity = integrityCheck(run);
  if (integrity) problems.push(`integrity: ${integrity === 'BLOCKED' ? 'records missing' : integrity}`);
  const updates = UPDATE_SCENARIOS.map((scenario) => run.updates?.[scenario]);
  if (![run.build?.persistence, ...updates.map((update) => update?.persistence)].every(persisted)) {
    problems.push('persistence readback missing or mismatched');
  }
  if (config === 'C') {
    const tokens = tokenCheck(run);
    if (tokens) problems.push(`tokens: ${tokens === 'BLOCKED' ? 'delivered inputs not verified' : tokens}`);
  } else if (![run.build?.delivered, run.queries?.delivered, ...updates.map((update) => update?.delivered)]
    .every((item) => isNumber(item?.count))) {
    problems.push('delivered inputs not captured');
  }
  return problems;
}

/**
 * Exactly five valid runs numbered 1-5 for one config; otherwise the reasons they cannot be used. M and C runs
 * must additionally satisfy the control hard invariants; A invariants are candidate gates instead.
 */
export function completeRuns(runs, config, snapshot, binding) {
  const selected = runs.filter((run) => run.config === config).sort((a, b) => a.run - b.run);
  const problems = selected.flatMap((run) => {
    const structural = validateRun(run, snapshot, binding);
    const control = structural.length === 0 && (config === 'M' || config === 'C') ? controlProblems(run, config) : [];
    return [...structural, ...control].map((problem) => `${config} run ${run.run}: ${problem}`);
  });
  if (JSON.stringify(selected.map((run) => run.run)) !== JSON.stringify([1, 2, 3, 4, 5])) {
    problems.push(`${config} needs runs 1-5 exactly once; found [${selected.map((run) => run.run).join(', ')}]`);
  }
  return { runs: selected, problems, complete: problems.length === 0 };
}

/** C-only anchors: questions whose gold source is in the final top six in every one of the five C runs. */
export function sealAnchors(cRuns, snapshot, binding) {
  const checked = completeRuns(cRuns, 'C', snapshot, binding);
  if (!checked.complete) throw new Error(`Anchors cannot be sealed: ${checked.problems.join('; ')}`);
  const covered = checked.runs.map((run) => new Map(run.queries.questions.map((question) =>
    [question.id, questionMetrics(question.stages.rerank, question.gold).goldSourceInTop6])));
  const groups = {};
  for (const group of [...new Set(snapshot.questions.map((question) => question.group))]) {
    const ids = snapshot.questions.filter((question) => question.group === group).map((question) => question.id);
    const anchorIds = ids.filter((id) => covered.every((run) => run.get(id)));
    groups[group] = {
      n: ids.length,
      m: anchorIds.length,
      anchorIds,
      intermittentIds: ids.filter((id) => !anchorIds.includes(id) && covered.some((run) => run.get(id))),
      perRunGoldSourceCoverage: covered.map((run) => ids.filter((id) => run.get(id)).length),
    };
  }
  return { binding, groups };
}

/**
 * Re-seals anchors from the bound five-run C baseline and requires the stored groups (IDs, n, m, intermittent IDs,
 * per-run coverage) to be identical. A matching file hash or binding alone is not accepted.
 */
export function verifyAnchors(anchors, baselineRuns, snapshot, binding) {
  const expected = sealAnchors(baselineRuns, snapshot, binding);
  if (JSON.stringify(anchors?.binding) !== JSON.stringify(binding) || JSON.stringify(anchors?.groups) !== JSON.stringify(expected.groups)) {
    throw new Error('Anchors do not match a fresh seal of the bound C baseline; evidence is blocked.');
  }
}

/** Anchored Section First@6 successes; a present question without a gold-source hit scores 0. */
export function anchoredSectionSuccesses(run, anchorIds) {
  return anchorIds.reduce((total, id) => {
    const question = run.queries.questions.find((item) => item.id === id);
    if (!question) throw new Error(`Anchored question ${id} is missing from run ${run.run}; the record is corrupt.`);
    return total + Number(questionMetrics(question.stages.rerank, question.gold).sectionFirstAt6);
  }, 0);
}

function gate(id, status, details = {}) {
  return { id, status, ...details };
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function lossGate(id, cValues, xValues, allowed) {
  return gate(id, median(cValues) - median(xValues) <= allowed ? 'PASS' : 'FAIL',
    { c: spread(cValues), candidate: spread(xValues), allowedLoss: allowed });
}

function ratioGate(id, cValues, xValues, limit) {
  if (!cValues || cValues.length !== REQUIRED_RUNS || xValues.length !== REQUIRED_RUNS || ![...cValues, ...xValues].every(isNumber)) {
    return gate(id, 'BLOCKED', { reason: 'missing measurement' });
  }
  const c = median(cValues);
  const x = median(xValues);
  if (c <= 0) return gate(id, 'NON_EVALUABLE', { reason: 'C median is zero', c: spread(cValues), candidate: spread(xValues) });
  return gate(id, x <= limit * c ? 'PASS' : 'FAIL', { ratio: x / c, limit, c: spread(cValues), candidate: spread(xValues) });
}

/** Per-run hard invariant: `check` returns 'BLOCKED' (unmeasured), a failure string, or undefined. */
function everyRun(id, runs, check) {
  const results = runs.map((run) => ({ run: run.run, result: check(run) }));
  const blocked = results.filter((item) => item.result === 'BLOCKED').map((item) => item.run);
  const failures = results.filter((item) => item.result && item.result !== 'BLOCKED');
  const status = blocked.length ? 'BLOCKED' : failures.length ? 'FAIL' : 'PASS';
  return gate(id, status, { blockedRuns: blocked, failures: failures.map((item) => ({ run: item.run, problem: item.result })) });
}

export function warmQueryMs(run) {
  const values = run.queries?.questions?.map((question) => question?.timings?.totalMs);
  return values?.length && values.every(isNumber) ? median(values) : undefined;
}

function persisted(persistence) {
  return persistence && Array.isArray(persistence.readbackMismatches) && persistence.readbackMismatches.length === 0 &&
    persistence.fileBytes && Object.keys(persistence.fileBytes).length > 0;
}

function rebuildMs(run) {
  return persisted(run.build?.persistence) ? run.build.rebuildMs : undefined;
}

function postIndexPrivateBytes(run) {
  const memory = run.memory?.postIndex;
  return memory?.stable === true && isNumber(memory.privateBytes) ? memory.privateBytes : undefined;
}

function processTypes(run) {
  return JSON.stringify([...(run.memory?.postIndex?.processTypes ?? [])].sort());
}

/** Privacy evidence of one run: offline demonstrated, every monitor installed, probes refused, no real egress. */
export function privacyCheck(run) {
  const network = run.network;
  if (!network?.monitors || !network.offline || !network.probes) return 'BLOCKED';
  const monitors = network.monitors;
  const workerCovered = monitors.workerNodeAvailable === false ||
    (monitors.workerNodeGuard === true && monitors.embeddingWorkerNodeGuard === true);
  if (!monitors.chromiumWebRequest || !monitors.mainNodeGuard || !monitors.rendererNodeGuard || !workerCovered) return 'BLOCKED';
  if (network.offline.before?.pageOnline !== false || network.offline.after?.pageOnline !== false ||
      network.offline.before?.workerOnline !== false || network.offline.after?.workerOnline !== false) return 'BLOCKED';
  const probes = network.probes;
  if (!probes.pageFetch?.refused || !probes.rendererNode?.refused || !probes.mainNode?.refused || !probes.worker?.fetchRefused ||
      (monitors.workerNodeAvailable && probes.worker?.nodeRefused !== true)) return 'BLOCKED';
  const attempts = network.actual?.chromiumBlocked + network.actual?.nodeExternal;
  if (!isNumber(attempts)) return 'BLOCKED';
  return attempts === 0 ? undefined : `${attempts} external request attempts`;
}

function tokenCheck(run) {
  const delivered = [run.build?.delivered, run.queries?.delivered, ...Object.values(run.updates ?? {}).map((update) => update.delivered)];
  if (delivered.some((item) => !item || item.matchesExpected === null || item.matchesExpected === undefined)) return 'BLOCKED';
  if (delivered.some((item) => !item.matchesExpected)) return 'delivered inputs differ from their projections';
  if (delivered.some((item) => item.overLimit !== 0 || item.maxTokens > MAX_MODEL_TOKENS)) return 'an input exceeds 512 tokens';
  return undefined;
}

/**
 * Registry and update integrity. The build and each of the three update scenarios must carry explicit
 * `integrityFailures` arrays, and each update an explicit `otherSourcesChanged` array; absent or mistyped evidence is
 * BLOCKED, never read as clean. Nonempty arrays are real failures.
 */
function integrityCheck(run) {
  const updates = UPDATE_SCENARIOS.map((scenario) => run.updates?.[scenario]);
  const arrays = [run.build?.integrityFailures, ...updates.flatMap((update) => [update?.integrityFailures, update?.otherSourcesChanged])];
  if (!arrays.every(Array.isArray) || typeof run.build.registryMatchesSnapshot !== 'boolean' ||
      typeof run.queries?.registryUnchanged !== 'boolean') return 'BLOCKED';
  if (run.build.integrityFailures.length || !run.build.registryMatchesSnapshot || !run.queries.registryUnchanged) {
    return 'chunk or source records differ from main';
  }
  if (updates.some((update) => update.integrityFailures.length)) return 'update integrity failure';
  if (updates.some((update) => update.otherSourcesChanged.length)) return 'an update changed another source';
  return undefined;
}

function coverageCheck() {
  return (run) => {
    const inputs = run.build?.inputs;
    if (!Array.isArray(inputs) || !Array.isArray(run.build?.attributes)) return 'BLOCKED';
    const missing = inputs.filter((input) => input.coverage?.some((field) => !field.represented));
    const has = (notePath, kind) => inputs.some((input) => input.path === notePath && input.kind === kind);
    const uncovered = run.build.attributes.filter((source) => source.status === 'valid' && source.fields.length > 0 &&
      has(source.path, 'body') && !has(source.path, 'attribute-chunk'));
    return missing.length || uncovered.length ? `${missing.length} inputs lose a field; ${uncovered.length} eligible sources unindexed` : undefined;
  };
}

function scenarioGate(runs, scenario, maxInputs, maxMedianMs) {
  const updates = runs.map((run) => run.updates?.[scenario]);
  const complete = updates.every((update) => update && isNumber(update.inference?.texts) && isNumber(update.ms) &&
    Array.isArray(update.otherSourcesChanged) && persisted(update.persistence) && update.delivered);
  if (!complete) return gate(`update:${scenario}`, 'BLOCKED', { reason: 'missing measurement or persistence readback' });
  const inputs = updates.map((update) => update.inference.texts);
  const times = updates.map((update) => update.ms);
  const pass = inputs.every((value) => value <= maxInputs) && updates.every((update) => update.otherSourcesChanged.length === 0) &&
    (maxMedianMs === undefined || median(times) <= maxMedianMs);
  return gate(`update:${scenario}`, pass ? 'PASS' : 'FAIL', { maxInputs, maxMedianMs: maxMedianMs ?? null,
    inputs: spread(inputs), ms: spread(times), otherSourcesChanged: updates.map((update) => update.otherSourcesChanged) });
}

/** Ordered gate definitions; ids are fixed so an incomplete candidate still reports every gate as BLOCKED. */
function gateDefinitions(xRuns, cRuns, perfC, anchors, parityPassed) {
  // Summaries are computed lazily so incomplete evidence can still list every gate as BLOCKED.
  let cache;
  const summaries = () => (cache ??= [xRuns, cRuns].map((runs) => runs.map((run) => summarizeRun(run.queries.questions))));
  const pick = (which, group, stage, key) => summaries()[which === 'x' ? 0 : 1].map((summary) => summary[group]?.[stage]?.[key] ?? 0);
  const size = (group) => summaries()[1][0]?.[group]?.questions ?? 0;
  const definitions = [];
  const add = (id, compute) => definitions.push({ id, compute });
  for (const group of GROUPS) {
    add(`group-size:${group}`, () => gate(`group-size:${group}`, size(group) >= MIN_GROUP_QUESTIONS ? 'PASS' : 'BLOCKED', { n: size(group) }));
  }
  add('integrity', () => everyRun('integrity', xRuns, integrityCheck));
  add('field-coverage', () => everyRun('field-coverage', xRuns, coverageCheck()));
  add('token-limit', () => parityPassed ? everyRun('token-limit', xRuns, tokenCheck)
    : gate('token-limit', 'BLOCKED', { reason: 'tokenizer parity preflight did not pass' }));
  add('external-requests', () => everyRun('external-requests', xRuns, privacyCheck));
  add('attribute-rerank-r3-gain', () => {
    const [x, c] = [pick('x','attribute', 'rerank', 'recallAt3'), pick('c','attribute', 'rerank', 'recallAt3')];
    return gate('attribute-rerank-r3-gain', median(x) - median(c) >= gain2(size('attribute')) ? 'PASS' : 'FAIL',
      { c: spread(c), candidate: spread(x), requiredGain: gain2(size('attribute')) });
  });
  for (const group of ['body', 'plain', 'similar']) {
    for (const stage of STAGES) {
      add(`r3-loss:${group}:${stage}`, () => lossGate(`r3-loss:${group}:${stage}`, pick('c',group, stage, 'recallAt3'),
        pick('x',group, stage, 'recallAt3'), loss1(size(group))));
    }
  }
  add('r1-loss:body:vector', () => lossGate('r1-loss:body:vector', pick('c','body', 'vector', 'recallAt1'),
    pick('x','body', 'vector', 'recallAt1'), loss1(size('body'))));
  for (const group of GROUPS) {
    add(`section-top1-loss:${group}`, () => lossGate(`section-top1-loss:${group}`, pick('c',group, 'rerank', 'sectionTop1'),
      pick('x',group, 'rerank', 'sectionTop1'), loss1(size(group))));
    add(`section-first6:${group}`, () => {
      const anchor = anchors.groups[group];
      if (!anchor || anchor.m === 0) return gate(`section-first6:${group}`, 'NON_EVALUABLE', { reason: 'no C-only anchors', m: anchor?.m ?? 0 });
      const c = cRuns.map((run) => anchoredSectionSuccesses(run, anchor.anchorIds));
      const x = xRuns.map((run) => anchoredSectionSuccesses(run, anchor.anchorIds));
      return gate(`section-first6:${group}`, median(x) >= median(c) ? 'PASS' : 'FAIL', { n: anchor.n, m: anchor.m, c: spread(c), candidate: spread(x) });
    });
  }
  for (const group of ['all', ...GROUPS]) {
    for (const key of ['wrongNoteTop1', 'wrongNoteTop3Slots']) {
      add(`${key}:${group}`, () => {
        const [c, x] = [pick('c',group, 'rerank', key), pick('x',group, 'rerank', key)];
        return gate(`${key}:${group}`, median(x) <= median(c) ? 'PASS' : 'FAIL', { c: spread(c), candidate: spread(x) });
      });
    }
  }
  add('rebuild-time', () => ratioGate('rebuild-time', perfC?.map(rebuildMs), xRuns.map(rebuildMs), 1.5));
  add('warm-query-time', () => ratioGate('warm-query-time', perfC?.map(warmQueryMs), xRuns.map(warmQueryMs), 1.5));
  add('post-index-private-memory', () => {
    if (perfC && new Set([...perfC, ...xRuns].map(processTypes)).size !== 1) {
      return gate('post-index-private-memory', 'BLOCKED', { reason: 'process sets differ between runs' });
    }
    return ratioGate('post-index-private-memory', perfC?.map(postIndexPrivateBytes), xRuns.map(postIndexPrivateBytes), 1.05);
  });
  add('update:nonTargetFrontmatter', () => scenarioGate(xRuns, 'nonTargetFrontmatter', 0));
  add('update:indexedAttribute', () => scenarioGate(xRuns, 'indexedAttribute', 16, 1000));
  add('update:body', () => scenarioGate(xRuns, 'body', 4, 300));
  return definitions;
}

/**
 * Applies the frozen matrix to one candidate on one dataset. `blockedReason` (incomplete or invalid evidence)
 * marks every gate BLOCKED. `perfC` are same-session C runs for time/memory ratios; without them those gates block.
 */
export function evaluateCandidate(config, xRuns, cRuns, perfC, anchors, { blockedReason, parityPassed = true } = {}) {
  if (config !== 'A') throw new Error('Unknown candidate config.');
  const definitions = gateDefinitions(xRuns, cRuns, perfC, anchors, parityPassed);
  if (blockedReason) return definitions.map(({ id }) => gate(id, 'BLOCKED', { reason: blockedReason }));
  return definitions.map(({ compute }) => compute());
}

/** PASS, FAIL (complete evidence, a gate failed), NOT_ADOPTABLE (non-evaluable, none failed) or INCOMPLETE. */
export function candidateStatus(gates) {
  if (gates.some((item) => item.status === 'BLOCKED')) return 'INCOMPLETE';
  if (gates.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (gates.some((item) => item.status === 'NON_EVALUABLE')) return 'NOT_ADOPTABLE';
  return 'PASS';
}

/**
 * Gate report for one dataset from verified raw runs. `baselineRuns` are the sealed C runs; `sessionRuns` hold the
 * later M/C/A session. Evidence is complete only with five valid runs of every config, and M/C controls must
 * satisfy their hard invariants. Anchors must equal a fresh seal of the complete baseline.
 */
export function evaluateDataset({ snapshot, binding, anchors, baselineRuns, sessionRuns, parityPassed }) {
  if ([...baselineRuns, ...sessionRuns].some((run) => !CONFIGS.includes(run?.config))) {
    throw new Error('Unknown run config in evidence.');
  }
  if (JSON.stringify(anchors.binding) !== JSON.stringify(binding)) throw new Error('Anchors are bound to another snapshot or implementation.');
  const baseline = completeRuns(baselineRuns, 'C', snapshot, binding);
  if (baseline.complete) verifyAnchors(anchors, baseline.runs, snapshot, binding);
  const checked = Object.fromEntries(CONFIGS.map((config) => [config, completeRuns(sessionRuns, config, snapshot, binding)]));
  const report = { binding, evidence: { baselineC: baseline.problems, ...Object.fromEntries(CONFIGS.map((config) =>
    [`session${config}`, checked[config].problems])) }, parityPassed, candidates: {} };
  for (const config of ['A']) {
    const reasons = [...(baseline.complete ? [] : ['sealed C evidence incomplete']), ...(checked[config].complete ? [] : [`${config} evidence incomplete`])];
    const gates = evaluateCandidate(config, checked[config].runs, baseline.runs, checked.C.complete ? checked.C.runs : undefined,
      anchors, { blockedReason: reasons.join('; ') || undefined, parityPassed });
    const status = candidateStatus(gates);
    report.candidates[config] = { status, failedGates: gates.filter((item) => item.status === 'FAIL').map((item) => item.id),
      blockedGates: gates.filter((item) => item.status === 'BLOCKED').map((item) => item.id), gates,
      warmQueryMs: checked[config].complete && checked[config].runs.every((run) => isNumber(warmQueryMs(run)))
        ? median(checked[config].runs.map(warmQueryMs)) : null,
      postIndexPrivateBytes: checked[config].complete && checked[config].runs.every((run) => isNumber(postIndexPrivateBytes(run)))
        ? median(checked[config].runs.map(postIndexPrivateBytes)) : null };
  }
  report.evidenceComplete = baseline.complete && CONFIGS.every((config) => checked[config].complete) && parityPassed === true &&
    Object.values(report.candidates).every((candidate) => candidate.status !== 'INCOMPLETE');
  return report;
}

/**
 * Cross-dataset decision. Two distinct, complete reports are needed; only A can be adopted.
 */
export function selectOutcome(reports) {
  if (reports.some((report) => Object.keys(report?.candidates ?? {}).some((config) => config !== 'A'))) {
    throw new Error('Unknown candidate config in gate report.');
  }
  const statuses = reports.map((report) => report.candidates?.A?.status ?? 'INCOMPLETE');
  const status = { A: statuses.includes('INCOMPLETE') || statuses.some((item) => !['PASS', 'FAIL', 'NOT_ADOPTABLE'].includes(item))
    ? 'INCOMPLETE' : statuses.every((item) => item === 'PASS') ? 'PASS'
      : statuses.includes('FAIL') ? 'FAIL' : 'NOT_ADOPTABLE' };
  const datasets = new Set(reports.map((report) => report.binding?.datasetName));
  if (datasets.size < 2 || datasets.size !== reports.length) {
    return { outcome: 'blocked', reason: 'one complete gate report per dataset, original and held-out, is required', status };
  }
  if (reports.some((report) => !report.evidenceComplete) || Object.values(status).includes('INCOMPLETE')) {
    return { outcome: 'blocked', reason: 'evidence is incomplete; no rejection or adoption can be claimed', status };
  }
  if (status.A === 'PASS') return { outcome: 'adopt', config: 'A', status };
  return { outcome: 'nonadoption', status };
}

// Inclusion-route diagnostics only: neither rerank causality nor quality attribution.
function candidateSources(record) {
  const stages = record?.stages;
  const metadata = stages?.channels?.metadata;
  const metadataTop20DistinctSources = Array.isArray(metadata) && metadata.slice(0, 20).every((item) => typeof item?.sourceId === 'string')
    ? new Set(metadata.slice(0, 20).map((item) => item.sourceId)).size : null;
  const stage = (name) => {
    const candidates = stages?.[name];
    if (!Array.isArray(candidates)) return { unprotectedSources: null, goldEntry: 'unavailable' };
    const unprotected = candidates.filter((item) => item?.protected === false);
    const unprotectedSources = candidates.some((item) => !item || typeof item.protected !== 'boolean') ||
      unprotected.some((item) => typeof item.sourceId !== 'string') ? null
      : Object.fromEntries([...new Set(unprotected.map((item) => item.sourceId))].sort().map((sourceId) =>
        [sourceId, unprotected.filter((item) => item.sourceId === sourceId).length]));
    if (typeof record?.gold?.chunkId !== 'string' || candidates.some((item) => !item || typeof item.chunkId !== 'string')) {
      return { unprotectedSources, goldEntry: 'unavailable' };
    }
    const gold = candidates.find((item) => item.chunkId === record.gold.chunkId);
    if (!gold) return { unprotectedSources, goldEntry: 'absent' };
    let goldEntry = 'unavailable';
    if (gold.protected === true && Number.isInteger(gold.bodyListRank) &&
        gold.bodyListRank >= 1 && gold.bodyListRank <= 16) goldEntry = 'protected-body';
    else if (gold.protected === false) {
      if (Number.isInteger(gold.bodyListRank) && gold.bodyListRank >= 17 && gold.bodyListRank <= 20) goldEntry = 'body-tail';
      else if (gold.bodyListRank === null && Number.isInteger(gold.metadataRank) && gold.metadataRank > 0) goldEntry = 'metadata-entry';
    }
    return { unprotectedSources, goldEntry };
  };
  return { metadataTop20DistinctSources, vector: stage('vector'), hybrid: stage('hybrid') };
}

/** Auditable per-config report recomputed from raw runs: five-run spreads, coverage, tokens, timing, memory, bytes. */
export function auditReport(runs, snapshot) {
  if (runs.some((run) => !CONFIGS.includes(run?.config))) throw new Error('Unknown run config in audit.');
  if (runs.some(hasUnknownInputKind)) throw new Error('Unknown input kind in audit.');
  const report = {};
  for (const config of CONFIGS) {
    const selected = runs.filter((run) => run.config === config).sort((a, b) => a.run - b.run);
    if (selected.length === 0) continue;
    const ranked = selected.every((run) => run.queries?.questions?.every((record) => STAGES.every((stage) =>
      Array.isArray(record?.stages?.[stage]) && record.stages[stage].every((hit) => hit && typeof hit.chunkId === 'string'))));
    const summaries = ranked ? selected.map((run) => summarizeRun(run.queries.questions)) : [];
    const quality = ranked ? Object.fromEntries(Object.keys(summaries[0]).map((group) => [group, Object.fromEntries(STAGES.map((stage) =>
      [stage, Object.fromEntries(Object.keys(summaries[0][group][stage]).map((key) =>
        [key, spread(summaries.map((summary) => summary[group][stage][key]))]))]))])) : null;
    const perQuestion = snapshot.questions.map((question) => {
      const records = selected.map((run) => run.queries?.questions?.find((item) => item?.id === question.id));
      const metrics = records.map((record) => Array.isArray(record?.stages?.rerank) &&
        record.stages.rerank.every((hit) => hit && typeof hit.chunkId === 'string') && record.gold
        ? questionMetrics(record.stages.rerank, record.gold) : null);
      return { id: question.id, group: question.group, route: records[0]?.route ?? null,
        goldSourceInTop6Runs: metrics.every(Boolean) ? metrics.filter((item) => item.goldSourceInTop6).length : null,
        noResultRuns: metrics.every(Boolean) ? metrics.filter((item) => item.noResult).length : null,
        rerankGoldRanks: metrics.map((item) => item?.goldRank ?? null),
        ...(config === 'A' ? { candidateSources: records.map((record, index) =>
          ({ run: selected[index].run, ...candidateSources(record) })) } : {}) };
    });
    const distribution = (values) => values.length ? { min: Math.min(...values), median: median(values),
      p95: quantile(values, 0.95), max: Math.max(...values), count: values.length } : null;
    const numbers = (pick) => { const values = selected.map(pick); return values.every(isNumber) ? spread(values) : null; };
    // Per-key five-run spreads of objects such as {kind: bytes}; a key missing in any run is reported, not hidden.
    const keyed = (pick) => {
      const objects = selected.map(pick);
      const keys = [...new Set(objects.flatMap((object) => Object.keys(object ?? {})))].sort();
      return { perRun: objects.map((object, index) => ({ run: selected[index].run, values: object ?? null })),
        byKey: Object.fromEntries(keys.map((key) => {
          const values = objects.map((object) => object?.[key]);
          return [key, values.every(isNumber) ? spread(values) : { values, incomplete: true }];
        })) };
    };
    const tokenRuns = selected.map((run) => {
      const kinds = {};
      for (const input of run.build?.inputs ?? []) {
        kinds[input.kind] ??= { original: [], projected: [], truncated: 0 };
        if (isNumber(input.originalTokens)) kinds[input.kind].original.push(input.originalTokens);
        if (isNumber(input.projectedTokens)) kinds[input.kind].projected.push(input.projectedTokens);
        if (input.truncated) kinds[input.kind].truncated += 1;
      }
      return { run: run.run, kinds: Object.fromEntries(Object.entries(kinds).map(([kind, item]) => [kind,
        { original: distribution(item.original), projected: distribution(item.projected), truncated: item.truncated }])),
      query: Array.isArray(run.queries?.questions)
        ? distribution(run.queries.questions.map((question) => question?.delivered?.tokens).filter(isNumber)) : null };
    });
    const kinds = [...new Set(tokenRuns.flatMap((item) => Object.keys(item.kinds)))].sort();
    const statSpread = (pick) => { const values = tokenRuns.map(pick); return values.every(isNumber) ? spread(values) : { values, incomplete: true }; };
    report[config] = {
      runs: selected.map((run) => run.run),
      quality,
      perQuestion,
      tokens: {
        perRun: tokenRuns,
        byKind: Object.fromEntries(kinds.map((kind) => [kind, {
          originalMax: statSpread((item) => item.kinds[kind]?.original?.max),
          originalMedian: statSpread((item) => item.kinds[kind]?.original?.median),
          projectedMax: statSpread((item) => item.kinds[kind]?.projected?.max),
          projectedMedian: statSpread((item) => item.kinds[kind]?.projected?.median),
          inputs: statSpread((item) => item.kinds[kind]?.original?.count ?? item.kinds[kind]?.projected?.count),
          truncated: statSpread((item) => item.kinds[kind]?.truncated),
        }])),
        queryMax: statSpread((item) => item.query?.max),
      },
      rebuildMs: numbers((run) => run.build?.rebuildMs),
      warmQueryMs: numbers(warmQueryMs),
      postIndexPrivateBytes: numbers((run) => run.memory?.postIndex?.privateBytes),
      sampledPeakPrivateBytes: numbers((run) => run.memory?.peaks?.privateBytes),
      peakWorkingSetBytes: numbers((run) => run.memory?.peaks?.workingSetBytes),
      persistedFileBytes: {
        preBuild: keyed((run) => run.build?.persistence?.pre),
        postBuild: keyed((run) => run.build?.persistence?.fileBytes),
        serializedPostBuild: keyed((run) => run.build?.persistence?.serializedBytes),
        postUpdate: Object.fromEntries(UPDATE_SCENARIOS.map((scenario) =>
          [scenario, keyed((run) => run.updates?.[scenario]?.persistence?.fileBytes)])),
      },
      vectorCounts: {
        postBuild: keyed((run) => run.build?.vectorCounts),
        postUpdate: Object.fromEntries(UPDATE_SCENARIOS.map((scenario) => [scenario, keyed((run) => run.updates?.[scenario]?.vectorCounts)])),
      },
      updates: Object.fromEntries(UPDATE_SCENARIOS.map((scenario) => [scenario, {
        inputs: numbers((run) => run.updates?.[scenario]?.inference?.texts),
        ms: numbers((run) => run.updates?.[scenario]?.ms),
      }])),
    };
  }
  return report;
}
