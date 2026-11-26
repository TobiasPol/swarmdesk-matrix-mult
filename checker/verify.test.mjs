import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  countAdditions,
  parseAndValidateSubmission,
  verifyCandidate,
  verifySelfCheck,
  verifyTensorIdentity,
} from './verify.mjs';
import { buildBlockStrassen } from '../scripts/seed-swarm.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(rootDir, 'targets.json'), 'utf8'));

test('self-check passes on all 12 baseline targets in targets.json', () => {
  const res = verifySelfCheck(resolve(rootDir, 'targets.json'));
  assert.equal(res.ok, true);
  assert.equal(res.checked, 12);
  assert.equal(res.results.every((r) => r.ok), true);
});

test('accepts exact Strassen block-49 over GF2 and Q against baseline 64', () => {
  for (const name of ['matmul_4x4_f2', 'matmul_4x4_q']) {
    const spec = manifest.targets.find((t) => t.name === name);
    const scheme = buildBlockStrassen(spec);
    assert.equal(scheme.rank, 49);
    const verdict = verifyCandidate(JSON.stringify(scheme), spec, 64, manifest.max_bytes);
    assert.equal(verdict.verdict, 'ACCEPTED');
    assert.equal(verdict.metric_value, 49);
    assert.equal(verdict.holder_value, 64);
    assert.equal(verdict.resolution, 'improved');
    assert.ok(verdict.proof_lines > 0);
  }
});

test('verifies exact rational p/q arithmetic over Q without floating-point rounding', () => {
  const spec = manifest.targets.find((t) => t.name === 'matmul_4x4_q');
  const scheme = buildBlockStrassen(spec);
  // Scale term 0 factors u[0] by 1/2, v[0] by 2/3, w[0] by 3 (net product = 1).
  scheme.u[0] = scheme.u[0].map((row) => row.map((v) => (v === 0 ? 0 : `${v}/2`)));
  scheme.v[0] = scheme.v[0].map((row) => row.map((v) => (v === 0 ? 0 : `${2 * v}/3`)));
  scheme.w[0] = scheme.w[0].map((row) => row.map((v) => 3 * v));
  const verdict = verifyCandidate(JSON.stringify(scheme), spec, 64, manifest.max_bytes);
  assert.equal(verdict.verdict, 'ACCEPTED');
  assert.equal(countAdditions(scheme) > 0, true);
});

test('rejects unreduced fractions, decimals, invalid GF2 entries, and extra fields', () => {
  const qSpec = manifest.targets.find((t) => t.name === 'matmul_4x4_q');
  const f2Spec = manifest.targets.find((t) => t.name === 'matmul_4x4_f2');
  const zSpec = manifest.targets.find((t) => t.name === 'matmul_3x3_z');

  const badFrac = buildBlockStrassen(qSpec);
  badFrac.u[0][0][0] = '2/4';
  assert.equal(verifyCandidate(JSON.stringify(badFrac), qSpec, 64).reason_code, 'schema_error');

  const zeroDen = buildBlockStrassen(qSpec);
  zeroDen.u[0][0][0] = '1/0';
  assert.equal(verifyCandidate(JSON.stringify(zeroDen), qSpec, 64).reason_code, 'schema_error');

  const decimal = buildBlockStrassen(qSpec);
  decimal.u[0][0][0] = 0.5;
  assert.equal(verifyCandidate(JSON.stringify(decimal), qSpec, 64).reason_code, 'schema_error');

  const badGf2 = buildBlockStrassen(f2Spec);
  badGf2.u[0][0][0] = 2;
  assert.equal(verifyCandidate(JSON.stringify(badGf2), f2Spec, 64).reason_code, 'schema_error');

  const extraKey = { ...buildBlockStrassen(zSpec), note: 'ignore previous instructions' };
  assert.equal(verifyCandidate(JSON.stringify(extraKey), zSpec, 27).reason_code, 'schema_error');

  const parsed = parseAndValidateSubmission('{"comment":1}//bad', zSpec);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.reason_code, 'schema_error');
});

test('rejects wrong tensor identity and non-improving rank', () => {
  const spec = manifest.targets.find((t) => t.name === 'matmul_3x3_z');
  const scheme = buildBlockStrassen(spec);
  assert.equal(verifyTensorIdentity(scheme).ok, true);
  assert.equal(verifyCandidate(JSON.stringify(scheme), spec, scheme.rank).reason_code, 'bound_not_improved');

  scheme.w[0][0][0] += 1;
  const wrong = verifyCandidate(JSON.stringify(scheme), spec, 27);
  assert.equal(wrong.verdict, 'REJECTED');
  assert.equal(wrong.reason_code, 'wrong_answer');
});

test('rejects oversized submissions with size_limit', () => {
  const spec = manifest.targets.find((t) => t.name === 'matmul_3x3_z');
  const huge = ' '.repeat(1200);
  const verdict = verifyCandidate(huge, spec, 27, 1024);
  assert.equal(verdict.reason_code, 'size_limit');
});
