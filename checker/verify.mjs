#!/usr/bin/env node
// Zero-dependency exact verifier for matrix-multiplication bilinear rank decompositions over Z, Q, and GF(2).
//
// Usage:
//   node checker/verify.mjs --self-check [targets.json]
//   node checker/verify.mjs verify --targets targets.json --target <name> --candidate <file> [--holder <file>] [--out <final.json>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MAX_RANK = 256;
export const MAX_INT_ABS = 1_000_000;

const REQUIRED_KEYS = ['target', 'ring', 'm', 'k', 'n', 'rank', 'u', 'v', 'w'];
const ALLOWED_KEYS = new Set(REQUIRED_KEYS);
const FRAC_RE = /^-?[1-9][0-9]*\/[1-9][0-9]*$/;

function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function lcmBig(a, b) {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcdBig(a, b)) * b;
}

function rejected(reasonCode, reason, extra = {}) {
  return {
    verdict: 'REJECTED',
    reason_code: reasonCode,
    reason,
    resolution: '',
    metric_value: extra.metric_value ?? null,
    holder_value: extra.holder_value ?? null,
    proof_lines: 0,
    wasm_bytes: 0,
    class_fuel: '{}',
  };
}

function parseScalar(val, ring, label) {
  if (ring === 'GF2') {
    if (!Number.isSafeInteger(val) || (val !== 0 && val !== 1)) {
      return { ok: false, error: `${label} must be 0 or 1 over GF2` };
    }
    return { ok: true, value: val };
  }
  if (ring === 'Z') {
    if (!Number.isSafeInteger(val)) return { ok: false, error: `${label} must be an integer` };
    if (Math.abs(val) > MAX_INT_ABS) {
      return { ok: false, error: `${label} exceeds magnitude limit ${MAX_INT_ABS}` };
    }
    return { ok: true, value: BigInt(val) };
  }
  if (ring === 'Q') {
    if (typeof val === 'number') {
      if (!Number.isSafeInteger(val)) return { ok: false, error: `${label} must be an integer or reduced p/q string` };
      if (Math.abs(val) > MAX_INT_ABS) {
        return { ok: false, error: `${label} exceeds magnitude limit ${MAX_INT_ABS}` };
      }
      return { ok: true, value: { num: BigInt(val), den: 1n } };
    }
    if (typeof val === 'string' && FRAC_RE.test(val)) {
      const [numStr, denStr] = val.split('/');
      const num = BigInt(numStr);
      const den = BigInt(denStr);
      if (den <= 1n) return { ok: false, error: `${label} denominator must be > 1` };
      if (gcdBig(num, den) !== 1n) return { ok: false, error: `${label} fraction must be reduced` };
      const absNum = num < 0n ? -num : num;
      if (absNum > BigInt(MAX_INT_ABS) || den > BigInt(MAX_INT_ABS)) {
        return { ok: false, error: `${label} exceeds magnitude limit ${MAX_INT_ABS}` };
      }
      return { ok: true, value: { num, den } };
    }
    return { ok: false, error: `${label} must be an integer or canonical p/q fraction` };
  }
  return { ok: false, error: `unsupported ring ${ring}` };
}

function validateMatrix(mat, rows, cols, ring, label) {
  if (!Array.isArray(mat) || mat.length !== rows) {
    return `${label} must have ${rows} rows`;
  }
  for (let r = 0; r < rows; r += 1) {
    const row = mat[r];
    if (!Array.isArray(row) || row.length !== cols) {
      return `${label}[${r}] must have ${cols} columns`;
    }
    for (let c = 0; c < cols; c += 1) {
      const parsed = parseScalar(row[c], ring, `${label}[${r}][${c}]`);
      if (!parsed.ok) return parsed.error;
    }
  }
  return null;
}

export function parseAndValidateSubmission(rawText, targetSpec, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { ok: false, error: rejected('schema_error', 'submission file is empty') };
  }
  const byteLen = Buffer.byteLength(rawText, 'utf8');
  if (byteLen > maxBytes) {
    return { ok: false, error: rejected('size_limit', `submission exceeds ${maxBytes} bytes`) };
  }
  if (rawText.includes('\0') || rawText.charCodeAt(0) === 0xfeff) {
    return { ok: false, error: rejected('schema_error', 'submission contains invalid control bytes') };
  }

  let doc;
  try {
    doc = JSON.parse(rawText);
  } catch {
    return { ok: false, error: rejected('schema_error', 'submission is not valid strict JSON') };
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: rejected('schema_error', 'submission root must be a JSON object') };
  }

  for (const key of Object.keys(doc)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: rejected('schema_error', `unexpected field: ${key.slice(0, 32)}`) };
    }
  }
  for (const req of REQUIRED_KEYS) {
    if (!(req in doc)) {
      return { ok: false, error: rejected('schema_error', `missing required field: ${req}`) };
    }
  }

  if (doc.target !== targetSpec.name) {
    return { ok: false, error: rejected('schema_error', 'target name does not match target spec') };
  }
  if (doc.ring !== targetSpec.ring) {
    return { ok: false, error: rejected('schema_error', `ring must be ${targetSpec.ring}`) };
  }
  if (doc.m !== targetSpec.m || doc.k !== targetSpec.k || doc.n !== targetSpec.n) {
    return {
      ok: false,
      error: rejected(
        'schema_error',
        `dimensions must be ${targetSpec.m}x${targetSpec.k}x${targetSpec.n}`,
      ),
    };
  }
  if (!Number.isInteger(doc.rank) || doc.rank < 1 || doc.rank > MAX_RANK) {
    return { ok: false, error: rejected('schema_error', `rank must be an integer in 1..${MAX_RANK}`) };
  }
  const R = doc.rank;
  if (
    !Array.isArray(doc.u) || doc.u.length !== R ||
    !Array.isArray(doc.v) || doc.v.length !== R ||
    !Array.isArray(doc.w) || doc.w.length !== R
  ) {
    return { ok: false, error: rejected('schema_error', 'u, v, and w must each have length rank') };
  }

  for (let r = 0; r < R; r += 1) {
    const uErr = validateMatrix(doc.u[r], targetSpec.m, targetSpec.k, targetSpec.ring, `u[${r}]`);
    if (uErr) return { ok: false, error: rejected('schema_error', uErr) };
    const vErr = validateMatrix(doc.v[r], targetSpec.k, targetSpec.n, targetSpec.ring, `v[${r}]`);
    if (vErr) return { ok: false, error: rejected('schema_error', vErr) };
    const wErr = validateMatrix(doc.w[r], targetSpec.m, targetSpec.n, targetSpec.ring, `w[${r}]`);
    if (wErr) return { ok: false, error: rejected('schema_error', wErr) };
  }

  return { ok: true, doc };
}

function isNonZero(val) {
  return val !== 0 && val !== '0';
}

function nonzeroEntries(mat, rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = mat[r][c];
      if (isNonZero(v)) out.push([r, c, v]);
    }
  }
  return out;
}

/** Counts scalar additions used by the bilinear scheme (lower is faster on real hardware). */
export function countAdditions(doc) {
  const { m, k, n, rank, u, v, w } = doc;
  let additions = 0;
  for (let r = 0; r < rank; r += 1) {
    const nnzU = nonzeroEntries(u[r], m, k).length;
    const nnzV = nonzeroEntries(v[r], k, n).length;
    if (nnzU > 1) additions += nnzU - 1;
    if (nnzV > 1) additions += nnzV - 1;
  }
  for (let ip = 0; ip < m; ip += 1) {
    for (let jp = 0; jp < n; jp += 1) {
      let terms = 0;
      for (let r = 0; r < rank; r += 1) {
        if (isNonZero(w[r][ip][jp])) terms += 1;
      }
      if (terms > 1) additions += terms - 1;
    }
  }
  return additions;
}

function parseQValue(val) {
  if (typeof val === 'number') return { num: BigInt(val), den: 1n };
  const [numStr, denStr] = val.split('/');
  return { num: BigInt(numStr), den: BigInt(denStr) };
}

function matrixDenominatorLcm(mat, rows, cols) {
  let lcm = 1n;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const { num, den } = parseQValue(mat[r][c]);
      if (num !== 0n && den > 1n) lcm = lcmBig(lcm, den);
    }
  }
  return lcm;
}

function scaledNonzeroQ(mat, rows, cols, factorLcm) {
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const { num, den } = parseQValue(mat[r][c]);
      if (num !== 0n) out.push([r, c, num * (factorLcm / den)]);
    }
  }
  return out;
}

function verifyGf2(doc) {
  const { m, k, n, rank, u, v, w } = doc;
  const dimB = k * n;
  const dimC = m * n;
  const acc = new Uint8Array(m * k * dimB * dimC);
  for (let r = 0; r < rank; r += 1) {
    const nzU = nonzeroEntries(u[r], m, k);
    const nzV = nonzeroEntries(v[r], k, n);
    const nzW = nonzeroEntries(w[r], m, n);
    for (const [i, kk] of nzU) {
      const aIdx = i * k + kk;
      for (const [kp, j] of nzV) {
        const abBase = (aIdx * dimB + kp * n + j) * dimC;
        for (const [ip, jp] of nzW) {
          acc[abBase + ip * n + jp] ^= 1;
        }
      }
    }
  }
  return checkAccumulator(m, k, n, acc, 1, 0);
}

function verifyInteger(doc) {
  const { m, k, n, rank, u, v, w } = doc;
  const dimB = k * n;
  const dimC = m * n;
  const acc = new Array(m * k * dimB * dimC).fill(0n);
  for (let r = 0; r < rank; r += 1) {
    const nzU = nonzeroEntries(u[r], m, k);
    const nzV = nonzeroEntries(v[r], k, n);
    const nzW = nonzeroEntries(w[r], m, n);
    for (const [i, kk, uVal] of nzU) {
      const aIdx = i * k + kk;
      const bu = BigInt(uVal);
      for (const [kp, j, vVal] of nzV) {
        const buv = bu * BigInt(vVal);
        const abBase = (aIdx * dimB + kp * n + j) * dimC;
        for (const [ip, jp, wVal] of nzW) {
          acc[abBase + ip * n + jp] += buv * BigInt(wVal);
        }
      }
    }
  }
  return checkAccumulator(m, k, n, acc, 1n, 0n);
}

function verifyRational(doc) {
  const { m, k, n, rank, u, v, w } = doc;
  const dimB = k * n;
  const dimC = m * n;
  const rankMeta = [];
  let globalLcm = 1n;
  for (let r = 0; r < rank; r += 1) {
    const du = matrixDenominatorLcm(u[r], m, k);
    const dv = matrixDenominatorLcm(v[r], k, n);
    const dw = matrixDenominatorLcm(w[r], m, n);
    const d = du * dv * dw;
    globalLcm = lcmBig(globalLcm, d);
    rankMeta.push({ du, dv, dw, d });
  }
  const acc = new Array(m * k * dimB * dimC).fill(0n);
  for (let r = 0; r < rank; r += 1) {
    const { du, dv, dw, d } = rankMeta[r];
    const scale = globalLcm / d;
    const nzU = scaledNonzeroQ(u[r], m, k, du);
    const nzV = scaledNonzeroQ(v[r], k, n, dv);
    const nzW = scaledNonzeroQ(w[r], m, n, dw);
    for (const [i, kk, uVal] of nzU) {
      const aIdx = i * k + kk;
      const bu = uVal * scale;
      for (const [kp, j, vVal] of nzV) {
        const buv = bu * vVal;
        const abBase = (aIdx * dimB + kp * n + j) * dimC;
        for (const [ip, jp, wVal] of nzW) {
          acc[abBase + ip * n + jp] += buv * wVal;
        }
      }
    }
  }
  return checkAccumulator(m, k, n, acc, globalLcm, 0n);
}

function checkAccumulator(m, k, n, acc, oneVal, zeroVal) {
  const dimB = k * n;
  const dimC = m * n;
  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) {
      const aIdx = i * k + kk;
      for (let kp = 0; kp < k; kp += 1) {
        for (let j = 0; j < n; j += 1) {
          const abBase = (aIdx * dimB + kp * n + j) * dimC;
          for (let ip = 0; ip < m; ip += 1) {
            for (let jp = 0; jp < n; jp += 1) {
              const idx = abBase + ip * n + jp;
              const expected = i === ip && kk === kp && j === jp ? oneVal : zeroVal;
              if (acc[idx] !== expected) {
                return {
                  ok: false,
                  mismatch: [i, kk, kp, j, ip, jp],
                  got: String(acc[idx]),
                  expected: String(expected),
                };
              }
            }
          }
        }
      }
    }
  }
  return { ok: true };
}

/**
 * Verifies exact identity:
 *   sum_{r=0}^{R-1} u[r][i][k] * v[r][kp][j] * w[r][ip][jp] == delta(i, ip) * delta(k, kp) * delta(j, jp)
 * over Z (exact BigInt), Q (exact common-denominator BigInt), or GF(2) (mod 2).
 */
export function verifyTensorIdentity(doc) {
  if (doc.ring === 'GF2') return verifyGf2(doc);
  if (doc.ring === 'Q') return verifyRational(doc);
  return verifyInteger(doc);
}

export function verifyCandidate(rawText, targetSpec, holderRank, maxBytes = DEFAULT_MAX_BYTES) {
  const parsed = parseAndValidateSubmission(rawText, targetSpec, maxBytes);
  if (!parsed.ok) {
    return { ...parsed.error, holder_value: holderRank };
  }
  const { doc } = parsed;
  const idCheck = verifyTensorIdentity(doc);
  if (!idCheck.ok) {
    return rejected(
      'wrong_answer',
      `tensor identity failed at (${idCheck.mismatch.join(',')})`,
      { metric_value: doc.rank, holder_value: holderRank },
    );
  }
  if (doc.rank >= holderRank) {
    return rejected(
      'bound_not_improved',
      `rank ${doc.rank} does not beat holder rank ${holderRank}`,
      { metric_value: doc.rank, holder_value: holderRank },
    );
  }
  const additions = countAdditions(doc);
  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `verified rank ${doc.rank} < holder ${holderRank} over ${doc.ring} (${additions} additions)`,
    resolution: 'improved',
    metric_value: doc.rank,
    holder_value: holderRank,
    proof_lines: additions,
    wasm_bytes: 0,
    class_fuel: '{}',
  };
}

export function verifySelfCheck(manifestPath) {
  const absManifest = resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const manifest = JSON.parse(readFileSync(absManifest, 'utf8'));
  const maxBytes = manifest.max_bytes ?? DEFAULT_MAX_BYTES;
  const results = [];
  let allOk = true;
  for (const target of manifest.targets ?? []) {
    const filePath = resolve(rootDir, target.file_path);
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseAndValidateSubmission(raw, target, maxBytes);
    if (!parsed.ok) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: parsed.error.reason_code, reason: parsed.error.reason });
      continue;
    }
    const idCheck = verifyTensorIdentity(parsed.doc);
    if (!idCheck.ok) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: 'wrong_answer', reason: `mismatch at ${idCheck.mismatch.join(',')}` });
      continue;
    }
    if (parsed.doc.rank > target.baseline_value) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: 'bound_not_improved', reason: `rank ${parsed.doc.rank} > baseline ${target.baseline_value}` });
      continue;
    }
    results.push({
      target: target.name,
      ok: true,
      rank: parsed.doc.rank,
      ring: parsed.doc.ring,
      additions: countAdditions(parsed.doc),
    });
  }
  return { ok: allOk, checked: results.length, results };
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

function main(argv) {
  if (argv[0] === '--self-check') {
    const res = verifySelfCheck(argv[1] ?? 'targets.json');
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (argv[0] === 'verify') {
    const flags = parseFlags(argv.slice(1));
    const manifestPath = flags.targets ?? 'targets.json';
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const targetSpec = (manifest.targets ?? []).find((t) => t.name === flags.target);
    if (!targetSpec) {
      const err = rejected('schema_error', 'unknown target');
      if (flags.out) writeFileSync(flags.out, `${JSON.stringify(err)}\n`);
      console.log(JSON.stringify(err));
      process.exit(0);
    }
    let holderRank = targetSpec.baseline_value;
    if (flags.holder) {
      const holderDoc = JSON.parse(readFileSync(flags.holder, 'utf8'));
      if (Number.isInteger(holderDoc?.rank)) holderRank = holderDoc.rank;
    }
    const rawCandidate = readFileSync(flags.candidate, 'utf8');
    const verdict = verifyCandidate(
      rawCandidate,
      targetSpec,
      holderRank,
      manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    );
    if (flags.out) writeFileSync(flags.out, `${JSON.stringify(verdict)}\n`);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  console.error('usage: verify.mjs --self-check [targets.json] | verify --targets <targets.json> --target <name> --candidate <file> [--holder <file>] [--out <final.json>]');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
