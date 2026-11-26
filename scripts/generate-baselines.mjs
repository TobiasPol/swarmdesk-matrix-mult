#!/usr/bin/env node
// Generates exact naive rank-(m*k*n) baseline decompositions for all targets in targets.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(rootDir, 'targets.json'), 'utf8'));

function zeros(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(0));
}

function buildNaive(target) {
  const { name, ring, m, k, n } = target;
  const u = [];
  const v = [];
  const w = [];
  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) {
      for (let j = 0; j < n; j += 1) {
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
  return { target: name, ring, m, k, n, rank: m * k * n, u, v, w };
}

for (const target of manifest.targets) {
  const outPath = resolve(rootDir, target.file_path);
  mkdirSync(dirname(outPath), { recursive: true });
  const doc = buildNaive(target);
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${target.file_path} (rank ${doc.rank})`);
}
