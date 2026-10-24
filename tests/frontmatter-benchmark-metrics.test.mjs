import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONFIGS, GROUPS, anchoredSectionSuccesses, auditReport, candidateStatus, completeRuns, evaluateCandidate, evaluateDataset, gain2, loss1,
  questionMetrics, recomputeQuestion, sealAnchors, selectOutcome, summarizeRun, validateRun, verifyAnchors, warmQueryMs,
} from '../scripts/frontmatter-benchmark/metrics.mjs';

const gold = { sourceId: 'g', chunkId: 'g2' };
const hit = (sourceId, chunkId) => ({ sourceId, chunkId });

test('Section First@6 scores the first gold-source hit, unlike overall exact-gold Recall@1', () => {
  const wrongNoteFirst = questionMetrics([hit('w', 'w1'), hit('g', 'g2')], gold);
  assert.deepEqual([wrongNoteFirst.recallAt1, wrongNoteFirst.sectionFirstAt6], [false, true]);
  const wrongSectionFirst = questionMetrics([hit('g', 'g1'), hit('g', 'g2')], gold);
  assert.deepEqual([wrongSectionFirst.recallAt1, wrongSectionFirst.sectionFirstAt6], [false, false]);
  const exact = questionMetrics([hit('g', 'g2'), hit('w', 'w1')], gold);
  assert.deepEqual([exact.recallAt1, exact.sectionFirstAt6], [true, true]);
});

test('no result or a gold source only at rank seven scores zero and counts wrong-note slots', () => {
  const empty = questionMetrics([], gold);
  assert.deepEqual([empty.noResult, empty.wrongNoteTop1, empty.sectionFirstAt6, empty.goldSourceInTop6], [true, false, false, false]);
  const late = questionMetrics([...Array.from({ length: 6 }, (_, index) => hit('w', `w${index}`)), hit('g', 'g2')], gold);
  assert.deepEqual([late.goldRank, late.recallAt6, late.goldSourceInTop6, late.sectionFirstAt6], [7, false, false, false]);
  assert.equal(questionMetrics([hit('w', 'w1'), hit('x', 'x1'), hit('g', 'g2')], gold).wrongNoteTop3Slots, 2);
});

test('frozen allowances scale with the group size', () => {
  assert.deepEqual([12, 13, 18, 24].map(gain2), [2, 3, 3, 4]);
  assert.deepEqual([12, 23, 24].map(loss1), [1, 1, 2]);
});

// A synthetic frozen snapshot: 12 questions per group, each with a gold chunk, a second chunk of the same note
// and a chunk of an unrelated note.
const ids = GROUPS.flatMap((group) => Array.from({ length: 12 }, (_, index) => `${group}-${index + 1}`));
const snapshot = {
  questions: ids.map((id) => ({ id, group: id.split('-')[0], question: `question ${id}`, path: `${id}.md` })),
  gold: ids.map((id) => ({ id, sourceId: `s-${id}`, chunkId: `g-${id}`, startLine: 1, endLine: 2 })),
  chunks: ids.flatMap((id) => [{ chunk_id: `g-${id}`, source_id: `s-${id}` }, { chunk_id: `o-${id}`, source_id: `s-${id}` },
    { chunk_id: `w-${id}`, source_id: `x-${id}` }]),
};
const binding = { snapshotSha256: 'snap', implementationSha256: 'impl' };
const LISTS = {
  gold: (id) => [hit(`s-${id}`, `g-${id}`), hit(`s-${id}`, `o-${id}`), hit(`x-${id}`, `w-${id}`)],
  wrongSection: (id) => [hit(`s-${id}`, `o-${id}`), hit(`s-${id}`, `g-${id}`), hit(`x-${id}`, `w-${id}`)],
  miss: (id) => [hit(`x-${id}`, `w-${id}`)],
};
const passingNetwork = () => ({
  offline: { before: { pageOnline: false, workerOnline: false }, after: { pageOnline: false, workerOnline: false } },
  monitors: { chromiumWebRequest: true, mainNodeGuard: true, rendererNodeGuard: true, workerNodeAvailable: false, workerNodeGuard: false },
  probes: { pageFetch: { refused: true }, rendererNode: { refused: true }, mainNode: { refused: true }, worker: { fetchRefused: true } },
  actual: { chromiumBlocked: 0, nodeExternal: 0 },
});
const delivered = () => ({ count: 1, matchesExpected: true, maxTokens: 20, overLimit: 0 });
const persistence = () => ({ readbackMismatches: [], fileBytes: { chunks: 10 } });

/** `pattern(id)` picks a ranked list per question; options override individual measurements. */
function makeRun(config, run, options = {}) {
  const { pattern = () => 'gold', rebuildMs = 10, privateBytes = 100, nonTargetInputs = 0, collateral = [],
    network = passingNetwork(), memoryStable = true, processTypes = ['Browser', 'Tab'] } = options;
  const questions = snapshot.questions.map((question, index) => {
    const list = LISTS[pattern(question.id)](question.id);
    const record = { ...question, route: 'implicit', gold: snapshot.gold[index], timings: { totalMs: 5 },
      stages: { vector: list, hybrid: list, rerank: list } };
    record.metrics = recomputeQuestion(record);
    return record;
  });
  const update = (texts) => ({ inference: { texts }, ms: 10, otherSourcesChanged: collateral, integrityFailures: [],
    persistence: persistence(), delivered: delivered() });
  return {
    config, run, binding,
    build: { integrityFailures: [], registryMatchesSnapshot: true, rebuildMs, attributes: [], persistence: persistence(),
      inputs: [{ path: 'n.md', kind: 'body', projectedTokens: 20 }], delivered: delivered() },
    queries: { registryUnchanged: true, delivered: delivered(), questions },
    summary: summarizeRun(questions),
    updates: { nonTargetFrontmatter: update(nonTargetInputs), indexedAttribute: update(4), body: update(1) },
    memory: { postIndex: { stable: memoryStable, privateBytes, processTypes } },
    network,
  };
}

const runs = (config, options) => [1, 2, 3, 4, 5].map((run) => makeRun(config, run, options));
const attributeGain = (id) => (id.startsWith('attribute-') && Number(id.split('-')[1]) <= 2 ? 'gold' : id.startsWith('attribute-') ? 'miss' : 'gold');
const cPattern = (id) => (id.startsWith('attribute-') ? 'miss' : 'gold');
const anchorsFor = (m) => ({ binding, groups: Object.fromEntries(GROUPS.map((group) => [group,
  { n: 12, m, anchorIds: m ? [`${group}-3`] : [] }])) });
const statusOf = (gates, id) => gates.find((item) => item.id === id).status;
const evaluate = (config, options, c = runs('C', { pattern: cPattern }), extra = {}) =>
  evaluateCandidate(config, runs(config, { pattern: attributeGain, ...options }), c, c, anchorsFor(1), extra);

test('raw records are checked against the snapshot: missing, reordered or altered evidence is reported', () => {
  assert.deepEqual(validateRun(makeRun('C', 1), snapshot, binding), []);
  const missing = makeRun('C', 1);
  missing.queries.questions.pop();
  assert.match(validateRun(missing, snapshot, binding).join(), /question records missing/);
  const reordered = makeRun('C', 1);
  reordered.queries.questions.reverse();
  assert.match(validateRun(reordered, snapshot, binding).join(), /differs from the snapshot/);
  const altered = makeRun('C', 1);
  altered.summary.all.rerank.recallAt3 += 1;
  assert.match(validateRun(altered, snapshot, binding).join(), /stored summary differs/);
  const wrongGold = makeRun('C', 1);
  wrongGold.queries.questions[0].gold = { ...wrongGold.queries.questions[0].gold, chunkId: 'o-attribute-1' };
  assert.match(validateRun(wrongGold, snapshot, binding).join(), /gold of attribute-1/);
  const foreign = makeRun('C', 1);
  foreign.queries.questions[1].stages.rerank = [hit('x-attribute-2', 'g-attribute-2')];
  assert.match(validateRun(foreign, snapshot, binding).join(), /rerank hits of attribute-2 are malformed/);
  assert.match(validateRun({ ...makeRun('C', 1), binding: { ...binding, snapshotSha256: 'other' } }, snapshot, binding).join(), /binding/);
});

test('five distinct complete runs are required; lost or duplicated runs block sealing', () => {
  assert.equal(completeRuns(runs('C'), 'C', snapshot, binding).complete, true);
  const duplicated = [...runs('C').slice(0, 4), makeRun('C', 4)];
  assert.match(completeRuns(duplicated, 'C', snapshot, binding).problems.join(), /runs 1-5 exactly once/);
  assert.throws(() => sealAnchors(runs('C').slice(0, 4), snapshot, binding), /cannot be sealed/);
});

test('anchors need gold-source coverage in all five C runs, recomputed from rankings, and ignore candidates', () => {
  const c = runs('C').map((run, index) => makeRun('C', run.run, { pattern: (id) =>
    (id === 'body-1' || (id === 'body-2' && index === 2)) ? 'miss' : 'gold' }));
  const tampered = structuredClone(c);
  tampered[0].queries.questions[5].metrics.rerank.goldSourceInTop6 = false;
  assert.throws(() => sealAnchors(tampered, snapshot, binding), /cannot be sealed/, 'stored flags are not trusted');
  const anchors = sealAnchors([...c, makeRun('A', 1)], snapshot, binding);
  assert.equal(anchors.groups.body.m, 10);
  assert.deepEqual(anchors.groups.body.intermittentIds, ['body-2']);
  assert.ok(!anchors.groups.body.anchorIds.includes('body-1'));
  assert.deepEqual(anchors.groups.body.perRunGoldSourceCoverage, [11, 11, 10, 11, 11]);
});

test('a candidate passes only when every frozen gate passes', () => {
  const gates = evaluate('A');
  assert.deepEqual(gates.filter((item) => item.status !== 'PASS'), []);
  assert.equal(candidateStatus(gates), 'PASS');
  const small = evaluate('A', { pattern: (id) => (id === 'attribute-1' ? 'gold' : cPattern(id)) });
  assert.equal(statusOf(small, 'attribute-rerank-r3-gain'), 'FAIL');
  assert.equal(candidateStatus(small), 'FAIL');
});

test('body recall tolerates one lost hit per 12 questions but not two', () => {
  const lose = (count) => (id) => (id.startsWith('body-') && Number(id.split('-')[1]) <= count ? 'miss' : attributeGain(id));
  assert.equal(statusOf(evaluate('A', { pattern: lose(1) }), 'r3-loss:body:hybrid'), 'PASS');
  assert.equal(statusOf(evaluate('A', { pattern: lose(2) }), 'r3-loss:body:hybrid'), 'FAIL');
});

test('within-note gate allows no loss on C anchors and is non-evaluable without anchors', () => {
  const lost = evaluate('A', { pattern: (id) => (id.endsWith('-3') ? 'wrongSection' : attributeGain(id)) });
  assert.equal(statusOf(lost, 'section-first6:body'), 'FAIL');
  const none = evaluateCandidate('A', runs('A', { pattern: attributeGain }), runs('C', { pattern: cPattern }),
    runs('C', { pattern: cPattern }), anchorsFor(0));
  assert.equal(statusOf(none, 'section-first6:plain'), 'NON_EVALUABLE');
  assert.equal(candidateStatus(none), 'NOT_ADOPTABLE', 'm=0 never auto-passes');
  const truncated = makeRun('A', 1);
  truncated.queries.questions = truncated.queries.questions.filter((question) => question.id !== 'body-3');
  assert.throws(() => anchoredSectionSuccesses(truncated, ['body-3']), /corrupt/);
});

test('incomplete evidence keeps quality failures visible but never becomes a rejection', () => {
  const gates = evaluate('A', { pattern: cPattern, privateBytes: null });
  assert.equal(statusOf(gates, 'attribute-rerank-r3-gain'), 'FAIL');
  assert.equal(statusOf(gates, 'post-index-private-memory'), 'BLOCKED');
  assert.equal(candidateStatus(gates), 'INCOMPLETE');
  const blocked = evaluateCandidate('A', runs('A').slice(0, 4), runs('C'), runs('C'), anchorsFor(1), { blockedReason: 'A evidence incomplete' });
  assert.ok(blocked.length > 40 && blocked.every((item) => item.status === 'BLOCKED'), 'every gate is listed as BLOCKED');
});

test('performance gates need same-session C, persisted rebuilds and stable comparable memory', () => {
  const c = runs('C', { pattern: cPattern });
  const x = runs('A', { pattern: attributeGain });
  assert.equal(statusOf(evaluateCandidate('A', x, c, undefined, anchorsFor(1)), 'rebuild-time'), 'BLOCKED');
  assert.equal(statusOf(evaluate('A', {}, c, {}), 'rebuild-time'), 'PASS');
  assert.equal(statusOf(evaluateCandidate('A', x, c, runs('C', { rebuildMs: 0 }), anchorsFor(1)), 'rebuild-time'), 'NON_EVALUABLE');
  const unpersisted = runs('A', { pattern: attributeGain });
  unpersisted[2].build.persistence.readbackMismatches = ['vectors-body'];
  assert.equal(statusOf(evaluateCandidate('A', unpersisted, c, c, anchorsFor(1)), 'rebuild-time'), 'BLOCKED');
  assert.equal(statusOf(evaluate('A', { memoryStable: false }), 'post-index-private-memory'), 'BLOCKED');
  assert.equal(statusOf(evaluate('A', { processTypes: ['Browser', 'GPU', 'Tab'] }), 'post-index-private-memory'), 'BLOCKED');
  assert.equal(statusOf(evaluate('A', { privateBytes: 106 }), 'post-index-private-memory'), 'FAIL');
});

test('privacy needs demonstrated offline execution, complete monitors and refused probes before real traffic counts', () => {
  const variant = (change) => { const network = passingNetwork(); change(network); return statusOf(evaluate('A', { network }), 'external-requests'); };
  assert.equal(variant(() => {}), 'PASS');
  assert.equal(variant((network) => { network.offline.before.pageOnline = true; }), 'BLOCKED');
  assert.equal(variant((network) => { network.monitors.workerNodeAvailable = true; }), 'BLOCKED');
  const workerProbe = (network) => { network.probes.worker.nodeRefused = true; };
  assert.equal(variant((network) => { workerProbe(network); Object.assign(network.monitors,
    { workerNodeAvailable: true, workerNodeGuard: true, embeddingWorkerNodeGuard: false }); }), 'BLOCKED',
  'the product embedding Worker must be guarded too');
  assert.equal(variant((network) => { workerProbe(network); Object.assign(network.monitors,
    { workerNodeAvailable: true, workerNodeGuard: true, embeddingWorkerNodeGuard: true }); }), 'PASS');
  assert.equal(variant((network) => { network.probes.mainNode.refused = false; }), 'BLOCKED');
  assert.equal(variant((network) => { network.actual.chromiumBlocked = 1; }), 'FAIL');
});

test('token compliance needs parity and literal delivered inputs within 512 tokens', () => {
  assert.equal(statusOf(evaluate('A', {}, undefined, { parityPassed: false }), 'token-limit'), 'BLOCKED');
  const x = runs('A', { pattern: attributeGain });
  x[0].queries.delivered.matchesExpected = false;
  const c = runs('C', { pattern: cPattern });
  assert.equal(statusOf(evaluateCandidate('A', x, c, c, anchorsFor(1)), 'token-limit'), 'FAIL');
  x[0].queries.delivered.matchesExpected = null;
  assert.equal(statusOf(evaluateCandidate('A', x, c, c, anchorsFor(1)), 'token-limit'), 'BLOCKED');
});

test('update gates fail on any re-embed for non-indexed edits or collateral source changes', () => {
  assert.equal(statusOf(evaluate('A', { nonTargetInputs: 1 }), 'update:nonTargetFrontmatter'), 'FAIL');
  assert.equal(statusOf(evaluate('A', { collateral: ['other.md'] }), 'update:body'), 'FAIL');
});

const session = () => [...runs('C'), ...runs('M'), ...runs('A')];
const evaluated = (sessionRuns, baselineRuns = runs('C'), anchors = sealAnchors(runs('C'), snapshot, binding)) =>
  evaluateDataset({ snapshot, binding, anchors, baselineRuns, sessionRuns, parityPassed: true });

test('dataset evaluation requires five M/C/A runs without B for complete evidence', () => {
  assert.deepEqual(CONFIGS, ['M', 'C', 'A']);
  assert.throws(() => evaluated(session(), runs('C'), { ...sealAnchors(runs('C'), snapshot, binding), binding: { other: true } }), /Anchors/);
  const withoutM = evaluated(session().filter((run) => run.config !== 'M'));
  assert.equal(withoutM.evidenceComplete, false, 'the M reference session is still missing');
  const complete = evaluated(session());
  assert.equal(complete.evidenceComplete, true);
  assert.deepEqual(Object.keys(complete.candidates), ['A']);
  assert.equal(complete.candidates.A.status, 'FAIL', 'no attribute gain over an equal C is a complete-evidence failure');
  assert.match(validateRun(makeRun('B', 1), snapshot, binding).join(), /valid config/);
  assert.throws(() => evaluated([...session(), makeRun('B', 1)]), /config/);
  const disguised = session();
  disguised.find((run) => run.config === 'A').build.inputs.push({ path: 'n.md', kind: 'attribute-note' });
  assert.match(validateRun(disguised.find((run) => run.config === 'A'), snapshot, binding).join(), /input kind/);
  assert.equal(evaluated(disguised).evidenceComplete, false);
  for (const change of [
    (run) => { run.build.vectorCounts = { body: 1, 'attribute-note': 1 }; },
    (run) => { run.updates.body.inferencesByKind = { body: 1, 'attribute-note': 1 }; },
    (run) => { run.updates.body.vectorCounts = { body: 1, 'attribute-note': 1 }; },
  ]) {
    const record = makeRun('A', 1);
    change(record);
    assert.match(validateRun(record, snapshot, binding).join(), /input kind/);
  }
});

test('dataset report keeps A warm-query timing unavailable when any of five complete runs lacks a measurement', () => {
  for (const timing of [undefined, null, NaN]) {
    const measured = session();
    const affected = measured.find((run) => run.config === 'A' && run.run === 3);
    affected.queries.questions[0].timings = { totalMs: timing };
    assert.equal(completeRuns(measured, 'A', snapshot, binding).complete, true);
    const result = evaluated(measured);
    assert.equal(result.candidates.A.warmQueryMs, null, `timing ${String(timing)}`);
    assert.equal(statusOf(result.candidates.A.gates, 'warm-query-time'), 'BLOCKED');
    assert.equal(result.candidates.A.status, 'INCOMPLETE');
    assert.equal(result.evidenceComplete, false);
  }
});

function incompleteRecord(absent) {
  const measured = session();
  delete measured.find((run) => run.config === 'A' && run.run === 3)[absent];
  const checked = completeRuns(measured, 'A', snapshot, binding);
  assert.equal(checked.complete, false, absent);
  const result = evaluated(measured);
  assert.equal(result.evidenceComplete, false, absent);
  assert.equal(result.candidates.A.status, 'INCOMPLETE', absent);
  assert.equal(statusOf(result.candidates.A.gates, 'warm-query-time'), 'BLOCKED', absent);
  assert.equal(result.candidates.A.warmQueryMs, null, absent);
  return auditReport(measured, snapshot).A;
}

test('missing whole queries give blocked evidence and unavailable question audit fields', () => {
  const audit = incompleteRecord('queries');
  assert.equal(audit.quality, null);
  assert.equal(audit.warmQueryMs, null);
  assert.deepEqual(audit.perQuestion[0].candidateSources[2].vector,
    { unprotectedSources: null, goldEntry: 'unavailable' });
  assert.equal(audit.tokens.queryMax.incomplete, true);
});

test('missing whole build gives blocked evidence and unavailable build audit fields', () => {
  const audit = incompleteRecord('build');
  assert.equal(audit.rebuildMs, null);
  assert.equal(audit.persistedFileBytes.postBuild.perRun[2].values, null);
  assert.equal(audit.vectorCounts.postBuild.perRun[2].values, null);
});

test('anchors whose IDs, m or coverage differ from a fresh seal of the bound C baseline are rejected', () => {
  const sealed = sealAnchors(runs('C'), snapshot, binding);
  assert.doesNotThrow(() => verifyAnchors(sealed, runs('C'), snapshot, binding));
  const deleted = structuredClone(sealed);
  deleted.groups.body.anchorIds = deleted.groups.body.anchorIds.slice(1);
  deleted.groups.body.m -= 1;
  const changedM = structuredClone(sealed);
  changedM.groups.plain.m = 0;
  const changedCoverage = structuredClone(sealed);
  changedCoverage.groups.similar.perRunGoldSourceCoverage[2] -= 1;
  for (const tampered of [deleted, changedM, changedCoverage]) {
    assert.throws(() => verifyAnchors(tampered, runs('C'), snapshot, binding), /fresh seal/);
    assert.throws(() => evaluated(session(), runs('C'), tampered), /fresh seal/);
  }
});

test('an M or C control run with egress, a missing monitor or broken invariants blocks the decision', () => {
  const breakRun = (config, change) => session().map((run) => {
    if (run.config === config && run.run === 3) change(run);
    return run;
  });
  const cases = [
    ['C', (run) => { run.network.actual.nodeExternal = 1; }],
    ['C', (run) => { delete run.network.monitors.rendererNodeGuard; }],
    ['C', (run) => { run.build.delivered.overLimit = 1; run.build.delivered.maxTokens = 600; }],
    ['M', (run) => { run.network.actual.chromiumBlocked = 2; }],
    ['M', (run) => { run.network.offline.after.pageOnline = true; }],
    ['M', (run) => { run.build.registryMatchesSnapshot = false; }],
    ['M', (run) => { run.updates.body.persistence.readbackMismatches = ['chunks']; }],
  ];
  for (const [config, change] of cases) {
    const result = evaluated(breakRun(config, change));
    assert.equal(result.evidenceComplete, false, `${config}: ${change}`);
    assert.ok(result.evidence[`session${config}`].length > 0);
    const decision = selectOutcome([result, { ...evaluated(session()), binding: { ...binding, datasetName: 'heldout' } }]);
    assert.equal(decision.outcome, 'blocked', 'never adopt or reject on broken control evidence');
  }
  const uncappedM = evaluated(breakRun('M', (run) => { run.build.delivered.maxTokens = 900; run.build.delivered.overLimit = 3; }));
  assert.equal(uncappedM.evidenceComplete, true, 'M deliberately embeds uncapped raw chunks and is not held to the C cap');
  const brokenBaseline = runs('C');
  brokenBaseline[1].network.monitors.mainNodeGuard = false;
  assert.throws(() => sealAnchors(brokenBaseline, snapshot, binding), /cannot be sealed/);
  const unsealable = evaluated(session(), brokenBaseline);
  assert.equal(unsealable.candidates.A.status, 'INCOMPLETE');
});

// The seven integrity arrays every run must carry explicitly (fake classification records, not scored runs).
const INTEGRITY_ARRAYS = [['build', 'integrityFailures'],
  ...['nonTargetFrontmatter', 'indexedAttribute', 'body'].flatMap((scenario) =>
    [['updates', scenario, 'integrityFailures'], ['updates', scenario, 'otherSourcesChanged']])];
const MISSING = [['deleted', undefined], ['null', null], ['object', {}], ['string', 'none']];

function withArray(run, keys, value) {
  const parent = keys.slice(0, -1).reduce((object, key) => object[key], run);
  if (value === undefined) delete parent[keys.at(-1)];
  else parent[keys.at(-1)] = value;
  return run;
}

function brokenAt(config, keys, value) {
  return session().map((run) => (run.config === config && run.run === 2 ? withArray(run, keys, value) : run));
}

test('M/C controls without every explicit integrity array cannot complete, seal or reach a decision', () => {
  for (const keys of INTEGRITY_ARRAYS) {
    for (const [label, value] of MISSING) {
      const name = `${keys.join('.')} ${label}`;
      for (const config of ['M', 'C']) {
        const runsWithGap = brokenAt(config, keys, value);
        assert.equal(completeRuns(runsWithGap, config, snapshot, binding).complete, false, `${config} ${name}`);
        const result = evaluated(runsWithGap);
        assert.equal(result.evidenceComplete, false, `${config} ${name}`);
        assert.equal(selectOutcome([result, { ...evaluated(session()), binding: { ...binding, datasetName: 'heldout' } }]).outcome,
          'blocked', `${config} ${name}`);
      }
      const baseline = runs('C');
      withArray(baseline[3], keys, value);
      assert.throws(() => sealAnchors(baseline, snapshot, binding), /cannot be sealed/, name);
    }
  }
});

test('nonempty integrity or collateral arrays are real failures for controls and candidates', () => {
  for (const keys of INTEGRITY_ARRAYS) {
    const name = keys.join('.');
    const value = keys.at(-1) === 'otherSourcesChanged' ? ['outside-four.md'] : [{ path: 'n.md', check: 'chunks-match-main' }];
    for (const config of ['M', 'C']) {
      const problems = completeRuns(brokenAt(config, keys, value), config, snapshot, binding).problems.join();
      assert.match(problems, /integrity: (?!records missing)/, `${config} ${name}`);
    }
    const baseline = runs('C');
    withArray(baseline[0], keys, value);
    assert.throws(() => sealAnchors(baseline, snapshot, binding), /cannot be sealed/, name);
    const candidate = runs('A', { pattern: attributeGain });
    withArray(candidate[4], keys, value);
    const c = runs('C', { pattern: cPattern });
    const gates = evaluateCandidate('A', candidate, c, c, anchorsFor(1));
    assert.equal(statusOf(gates, 'integrity'), 'FAIL', name);
    assert.equal(candidateStatus(gates), 'FAIL', `${name}: complete evidence with a real failure`);
  }
});

test('a candidate missing any integrity array is BLOCKED even when another quality gate fails', () => {
  for (const keys of INTEGRITY_ARRAYS) {
    for (const [label, value] of MISSING) {
      const candidate = runs('A', { pattern: cPattern });
      withArray(candidate[1], keys, value);
      const c = runs('C', { pattern: cPattern });
      const gates = evaluateCandidate('A', candidate, c, c, anchorsFor(1));
      assert.equal(statusOf(gates, 'integrity'), 'BLOCKED', `${keys.join('.')} ${label}`);
      assert.equal(statusOf(gates, 'attribute-rerank-r3-gain'), 'FAIL');
      assert.equal(candidateStatus(gates), 'INCOMPLETE', `${keys.join('.')} ${label}`);
    }
  }
});

test('the audit report aggregates tokens, disk bytes and vector counts over all five runs', () => {
  const varied = runs('C').map((run) => {
    run.build.inputs = [{ path: 'n.md', kind: 'body', originalTokens: 20 + run.run + (run.run === 5 ? 100 : 0),
      projectedTokens: 20 + run.run, truncated: run.run === 5 }];
    run.build.persistence = { readbackMismatches: [], pre: { sources: 5 }, fileBytes: { chunks: 10 * run.run, sources: 5 } };
    run.build.vectorCounts = { body: run.run };
    return run;
  });
  const audit = auditReport(varied, snapshot).C;
  assert.deepEqual(audit.tokens.byKind.body.projectedMax.values, [21, 22, 23, 24, 25]);
  assert.deepEqual(audit.tokens.byKind.body.truncated.values, [0, 0, 0, 0, 1]);
  assert.equal(audit.tokens.byKind.body.originalMax.max, 125);
  assert.deepEqual(audit.persistedFileBytes.postBuild.byKey.chunks.values, [10, 20, 30, 40, 50]);
  assert.equal(audit.persistedFileBytes.postBuild.byKey.chunks.median, 30);
  assert.deepEqual(audit.persistedFileBytes.preBuild.byKey.sources.values, [5, 5, 5, 5, 5]);
  assert.deepEqual(audit.vectorCounts.postBuild.byKey.body.values, [1, 2, 3, 4, 5]);
  assert.equal(audit.persistedFileBytes.postBuild.perRun.length, 5);
});

const report = (dataset, a, complete = true) => ({ binding: { datasetName: dataset }, evidenceComplete: complete,
  candidates: { A: { status: a } } });

test('selection needs complete evidence on both datasets and distinguishes nonadoption from blocked', () => {
  assert.equal(selectOutcome([report('original', 'PASS')]).outcome, 'blocked');
  assert.deepEqual(selectOutcome([report('original', 'PASS'), report('heldout', 'PASS')]),
    { outcome: 'adopt', config: 'A', status: { A: 'PASS' } });
  assert.equal(selectOutcome([report('original', 'PASS'), report('heldout', 'FAIL')]).outcome, 'nonadoption');
  assert.equal(selectOutcome([report('original', 'PASS'), report('heldout', 'NOT_ADOPTABLE')]).outcome, 'nonadoption');
  assert.equal(selectOutcome([report('original', 'INCOMPLETE'), report('heldout', 'FAIL')]).outcome, 'blocked');
  assert.equal(selectOutcome([report('original', 'FAIL', false), report('heldout', 'FAIL')]).outcome, 'blocked');
  assert.equal(selectOutcome([report('original', 'PASS'), report('original', 'PASS')]).outcome, 'blocked');
});

test('A gate IDs retain the frozen order and update limits', () => {
  const gates = evaluate('A');
  assert.deepEqual(gates.map((item) => item.id), [
    ...GROUPS.map((group) => `group-size:${group}`), 'integrity', 'field-coverage', 'token-limit', 'external-requests',
    'attribute-rerank-r3-gain',
    ...['body', 'plain', 'similar'].flatMap((group) => ['vector', 'hybrid', 'rerank'].map((stage) => `r3-loss:${group}:${stage}`)),
    'r1-loss:body:vector', ...GROUPS.flatMap((group) => [`section-top1-loss:${group}`, `section-first6:${group}`]),
    ...['all', ...GROUPS].flatMap((group) => [`wrongNoteTop1:${group}`, `wrongNoteTop3Slots:${group}`]),
    'rebuild-time', 'warm-query-time', 'post-index-private-memory',
    'update:nonTargetFrontmatter', 'update:indexedAttribute', 'update:body',
  ]);
  assert.deepEqual(gates.slice(-3).map(({ maxInputs, maxMedianMs }) => [maxInputs, maxMedianMs]),
    [[0, null], [16, 1000], [4, 300]]);
});

test('A field coverage fails for missing fields or absent chunk attributes and blocks on missing records', () => {
  const c = runs('C', { pattern: cPattern });
  const candidate = runs('A', { pattern: attributeGain });
  const coverage = () => statusOf(evaluateCandidate('A', candidate, c, c, anchorsFor(1)), 'field-coverage');
  assert.equal(coverage(), 'PASS');
  candidate[0].build.attributes = [{ path: 'n.md', status: 'valid', fields: ['title'] }];
  assert.equal(coverage(), 'FAIL');
  candidate[0].build.inputs.push({ path: 'n.md', kind: 'attribute-note', coverage: [{ field: 'title', represented: true }] });
  assert.equal(coverage(), 'FAIL');
  candidate[0].build.inputs.push({ path: 'n.md', kind: 'attribute-chunk', coverage: [{ field: 'title', represented: false }] });
  assert.equal(coverage(), 'FAIL');
  delete candidate[0].build.inputs;
  assert.equal(coverage(), 'BLOCKED');
});

test('A audit classifies gold inclusion separately for vector and hybrid without changing gate decisions', () => {
  const candidate = runs('A', { pattern: attributeGain });
  const first = candidate[0].queries.questions[0];
  const goldHit = (protectedBody, bodyListRank, metadataRank) =>
    ({ ...hit(first.gold.sourceId, first.gold.chunkId), protected: protectedBody, bodyListRank, metadataRank });
  const other = { ...hit('other', 'other-chunk'), protected: false, bodyListRank: null, metadataRank: 2 };
  const examples = [
    [goldHit(true, 1, 1), 'protected-body'], [goldHit(false, 18, 1), 'body-tail'],
    [goldHit(false, null, 1), 'metadata-entry'], [other, 'absent'],
    [{ ...goldHit(false, null, 1), metadataRank: undefined }, 'unavailable'],
    [{ ...goldHit(false, null, 1), protected: undefined }, 'unavailable'],
    [goldHit(true, null, 1), 'unavailable'],
    [goldHit(true, 17, 1), 'unavailable'],
    [goldHit(false, 1, 1), 'unavailable'],
    [goldHit(false, null, null), 'unavailable'],
    [{ ...goldHit(true, 1, 1), bodyListRank: undefined }, 'unavailable'],
  ];
  for (const [entry, expected] of examples) {
    first.stages.vector = [entry];
    first.stages.hybrid = [goldHit(false, null, 3), other];
    first.stages.bodyList = [goldHit(true, 1, 3)];
    first.stages.channels = { metadata: [hit('same', 'a'), hit('same', 'b'), hit('other', 'c')] };
    const recorded = auditReport(candidate, snapshot).A.perQuestion[0].candidateSources;
    assert.ok(Array.isArray(recorded), 'A audit must provide candidate-source diagnostics');
    const diagnostic = recorded[0];
    assert.equal(diagnostic.vector.goldEntry, expected);
    assert.equal(diagnostic.hybrid.goldEntry, 'metadata-entry');
    assert.equal(diagnostic.metadataTop20DistinctSources, 2);
    assert.deepEqual(diagnostic.hybrid.unprotectedSources, { [first.gold.sourceId]: 1, other: 1 });
  }
  const c = runs('C', { pattern: cPattern });
  const before = evaluateCandidate('A', candidate, c, c, anchorsFor(1));
  first.stages.channels.metadata[0].sourceId = 'changed';
  first.stages.vector[0].metadataRank = 4;
  assert.deepEqual(evaluateCandidate('A', candidate, c, c, anchorsFor(1)), before);
  assert.equal(auditReport(candidate, snapshot).A.perQuestion[0].candidateSources.length, 5);
});

test('A audit exposes repeated metadata sources while protected sixteen body hits remain present', () => {
  const candidates = [
    ...Array.from({ length: 16 }, (_, rank) => ({ ...hit(`body${rank}`, `b${rank}`), protected: true, bodyListRank: rank + 1, metadataRank: null })),
    ...Array.from({ length: 4 }, (_, rank) => ({ ...hit('repeat', `m${rank}`), protected: false, bodyListRank: null, metadataRank: rank + 1 })),
  ];
  const candidate = runs('A');
  const question = candidate[0].queries.questions[0];
  question.stages.hybrid = candidates;
  question.stages.vector = candidates;
  question.stages.channels = { metadata: Array.from({ length: 5 }, (_, rank) => hit('repeat', `m${rank}`)) };
  const recorded = auditReport(candidate, snapshot).A.perQuestion[0].candidateSources;
  assert.ok(Array.isArray(recorded), 'A audit must provide candidate-source diagnostics');
  const diagnostic = recorded[0];
  assert.equal(diagnostic.metadataTop20DistinctSources, 1);
  assert.deepEqual(diagnostic.hybrid.unprotectedSources, { repeat: 4 });
});

test('missing or null raw candidate fields produce unavailable diagnostics, not inferred entry routes', () => {
  const candidate = runs('A');
  const first = candidate[0].queries.questions[0];
  first.stages.vector = [null];
  first.stages.hybrid = undefined;
  first.stages.channels = { metadata: [null] };
  const diagnostic = auditReport(candidate, snapshot).A.perQuestion[0].candidateSources[0];
  assert.equal(diagnostic.metadataTop20DistinctSources, null);
  assert.deepEqual(diagnostic.vector, { unprotectedSources: null, goldEntry: 'unavailable' });
  assert.deepEqual(diagnostic.hybrid, { unprotectedSources: null, goldEntry: 'unavailable' });
  assert.match(validateRun(candidate[0], snapshot, binding).join(), /hits of attribute-1 are malformed/);
});

test('a null raw question is unavailable in audit and invalid as evidence', () => {
  const candidate = runs('A');
  candidate[0].queries.questions[0] = null;
  const audit = auditReport(candidate, snapshot).A;
  assert.equal(audit.quality, null);
  assert.equal(audit.warmQueryMs, null, 'a missing question cannot be omitted from timing samples');
  assert.deepEqual(audit.perQuestion[0].candidateSources[0].vector,
    { unprotectedSources: null, goldEntry: 'unavailable' });
  assert.match(validateRun(candidate[0], snapshot, binding).join(), /question 1 differs/);
});

test('missing, null and nonfinite query timings block the performance gate without shortening a run', () => {
  const candidate = runs('A', { pattern: attributeGain });
  const c = runs('C', { pattern: cPattern });
  for (const value of [undefined, null, NaN]) {
    const x = structuredClone(candidate);
    x[0].queries.questions[0].timings = value === undefined ? undefined : { totalMs: value };
    assert.equal(warmQueryMs(x[0]), undefined);
    assert.equal(auditReport(x, snapshot).A.warmQueryMs, null);
    const gates = evaluateCandidate('A', x, c, c, anchorsFor(1));
    assert.equal(statusOf(gates, 'warm-query-time'), 'BLOCKED');
    assert.equal(candidateStatus(gates), 'INCOMPLETE');
  }
});
