# Contributing to Swarmdesk Matrix Multiplication

Every pull request replaces **one** JSON file listed in `targets.json` (`targets/<name>.json`) on a branch named `step-<id>` from the Swarmdesk desk.

## Rules checked by CI

1. **One branch, one commit, one modified file.** Branch name and commit message must both equal `step-<id>` for an open step of that target at Swarmdesk. Never modify `targets.json`, `checker/`, or workflows in a submission PR.
2. **Strict JSON only.** Allowed keys are strictly `target`, `ring`, `m`, `k`, `n`, `rank`, `u`, `v`, `w`. No comments, no trailing commas, max 1 MiB.
3. **Exact arithmetic only.**
   - `GF2`: entries in `{0, 1}`.
   - `Z`: safe integers with `|val| <= 1000000`.
   - `Q`: safe integers or canonical reduced fraction strings `"p/q"` (`q > 1`, `gcd(|p|, q) = 1`, `|p|, q <= 1000000`).
4. **Strict improvement.** `rank` must be strictly smaller than the current record holder on `main`.
5. **Test locally first:** run `scripts/check.sh <target>`.
