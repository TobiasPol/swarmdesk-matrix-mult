#!/usr/bin/env node
// Local seed-swarm helper: constructs exact block-Strassen (and recursive 4x4 Strassen) schemes
// verified by checker/verify.mjs so the arena starts with genuine, reproducible sub-naive records.
//
// Usage:
//   node scripts/seed-swarm.mjs --dry-run
//   node scripts/seed-swarm.mjs --write matmul_4x4_f2
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countAdditions, verifyCandidate } from '../checker/verify.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(rootDir, 'targets.json'), 'utf8'));

function zeros(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(0));
}

function modNorm(val, ring) {
  if (ring !== 'GF2') return val;
  return ((val % 2) + 2) % 2;
}

function placeBlock(rows, cols, r0, c0, block, ring) {
  const out = zeros(rows, cols);
  for (let r = 0; r < block.length; r += 1) {
    for (let c = 0; c < block[r].length; c += 1) {
      out[r0 + r][c0 + c] = modNorm(block[r][c], ring);
    }
  }
  return out;
}

const STRASSEN_2X2 = [
  { u: [[1, 0], [0, 1]], v: [[1, 0], [0, 1]], w: [[1, 0], [0, 1]] },
  { u: [[0, 0], [1, 1]], v: [[1, 0], [0, 0]], w: [[0, 0], [1, -1]] },
  { u: [[1, 0], [0, 0]], v: [[0, 1], [0, -1]], w: [[0, 1], [0, 1]] },
  { u: [[0, 0], [0, 1]], v: [[-1, 0], [1, 0]], w: [[1, 0], [1, 0]] },
  { u: [[1, 1], [0, 0]], v: [[0, 0], [0, 1]], w: [[-1, 1], [0, 0]] },
  { u: [[-1, 0], [1, 0]], v: [[1, 1], [0, 0]], w: [[0, 0], [0, 1]] },
  { u: [[0, 1], [0, -1]], v: [[0, 0], [1, 1]], w: [[1, 0], [0, 0]] },
];

function kroneckerScheme(aTerms, bTerms, ring) {
  const out = [];
  const scale = (mat, s) => mat.map((row) => row.map((x) => modNorm(x * s, ring)));
  const kron = (m1, m2) => {
    const res = zeros(m1.length * m2.length, m1[0].length * m2[0].length);
    for (let r1 = 0; r1 < m1.length; r1 += 1) {
      for (let c1 = 0; c1 < m1[0].length; c1 += 1) {
        if (m1[r1][c1] === 0) continue;
        const scaled = scale(m2, m1[r1][c1]);
        for (let r2 = 0; r2 < m2.length; r2 += 1) {
          for (let c2 = 0; c2 < m2[0].length; c2 += 1) {
            res[r1 * m2.length + r2][c1 * m2[0].length + c2] = modNorm(scaled[r2][c2], ring);
          }
        }
      }
    }
    return res;
  };
  for (const a of aTerms) {
    for (const b of bTerms) {
      out.push({ u: kron(a.u, b.u), v: kron(a.v, b.v), w: kron(a.w, b.w) });
    }
  }
  return out;
}

/** Exact block-Strassen decomposition: uses recursive 4x4 Strassen (49) when m,k,n >= 4, plus 2x2x2 tiles (7) and naive scalars for remainders. */
export function buildBlockStrassen(targetSpec) {
  const { name, ring, m, k, n } = targetSpec;
  const u = [];
  const v = [];
  const w = [];
  const strassen4x4 = kroneckerScheme(STRASSEN_2X2, STRASSEN_2X2, ring);

  // Greedy non-overlapping tiling on the (m, k, n) 3D grid of matrix product terms.
  const covered = Array.from({ length: m }, () =>
    Array.from({ length: k }, () => Array(n).fill(false)),
  );

  const canCover = (i0, k0, j0, dm, dk, dn) => {
    if (i0 + dm > m || k0 + dk > k || j0 + dn > n) return false;
    for (let i = i0; i < i0 + dm; i += 1) {
      for (let kk = k0; kk < k0 + dk; kk += 1) {
        for (let j = j0; j < j0 + dn; j += 1) {
          if (covered[i][kk][j]) return false;
        }
      }
    }
    return true;
  };

  const markCovered = (i0, k0, j0, dm, dk, dn) => {
    for (let i = i0; i < i0 + dm; i += 1) {
      for (let kk = k0; kk < k0 + dk; kk += 1) {
        for (let j = j0; j < j0 + dn; j += 1) {
          covered[i][kk][j] = true;
        }
      }
    }
  };

  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) {
      for (let j = 0; j < n; j += 1) {
        if (canCover(i, kk, j, 4, 4, 4)) {
          markCovered(i, kk, j, 4, 4, 4);
          for (const t of strassen4x4) {
            u.push(placeBlock(m, k, i, kk, t.u, ring));
            v.push(placeBlock(k, n, kk, j, t.v, ring));
            w.push(placeBlock(m, n, i, j, t.w, ring));
          }
        }
      }
    }
  }

  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) {
      for (let j = 0; j < n; j += 1) {
        if (canCover(i, kk, j, 2, 2, 2)) {
          markCovered(i, kk, j, 2, 2, 2);
          for (const t of STRASSEN_2X2) {
            u.push(placeBlock(m, k, i, kk, t.u, ring));
            v.push(placeBlock(k, n, kk, j, t.v, ring));
            w.push(placeBlock(m, n, i, j, t.w, ring));
          }
        }
      }
    }
  }

  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) {
      for (let j = 0; j < n; j += 1) {
        if (!covered[i][kk][j]) {
          markCovered(i, kk, j, 1, 1, 1);
          const um = zeros(m, k);
          const vm = zeros(k, n);
          const wm = zeros(m, n);
          um[i][kk] = 1;
          vm[kk][j] = 1;
          wm[i][j] = 1;
          u.push(um);
          v.push(vm);
          w.push(wm);
        }
      }
    }
  }

  return { target: name, ring, m, k, n, rank: u.length, u, v, w };
}

function run() {
  const args = process.argv.slice(2);
  const writeIdx = args.indexOf('--write');
  const writeTarget = writeIdx !== -1 ? args[writeIdx + 1] : null;
  let allOk = true;

  for (const target of manifest.targets) {
    if (writeTarget && target.name !== writeTarget) continue;
    const holderRaw = readFileSync(resolve(rootDir, target.file_path), 'utf8');
    const holderDoc = JSON.parse(holderRaw);
    const candidate = buildBlockStrassen(target);
    const candJson = `${JSON.stringify(candidate, null, 2)}\n`;
    const verdict = verifyCandidate(candJson, target, holderDoc.rank, manifest.max_bytes);
    if (verdict.verdict !== 'ACCEPTED') {
      allOk = false;
      console.error(`FAIL ${target.name}: ${verdict.reason_code} ${verdict.reason}`);
      continue;
    }
    const adds = countAdditions(candidate);
    console.log(
      `${target.name.padEnd(18)} ring=${target.ring.padEnd(3)} holder=${String(holderDoc.rank).padStart(3)} -> strassen=${String(candidate.rank).padStart(3)} (sota=${String(target.sota_value).padStart(2)}, adds=${adds}) ACCEPTED`,
    );
    if (writeTarget === target.name) {
      writeFileSync(resolve(rootDir, target.file_path), candJson);
      console.log(`wrote ${target.file_path}`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run();
}
