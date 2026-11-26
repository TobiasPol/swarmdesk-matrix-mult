# How the Tensor-Rank Check Works

`swarmdesk-matrix-mult` verifies exact bilinear matrix-multiplication decompositions algebraically without floating-point arithmetic, compilers, or untrusted code execution.

## Layered defense

1. **`TobiasPol/swarmdesk-sdk/action` (`guard`)**: reads PR metadata and fetches only the single modified blob by SHA via GitHub's API. Fork code is never checked out.
2. **Strict schema validation (`checker/verify.mjs`)**: enforces strict JSON, exact key allowlist (`target`, `ring`, `m`, `k`, `n`, `rank`, `u`, `v`, `w`), dimensions `(m,k,n)`, `1 <= rank <= 256`, and ring constraints (`GF2`, `Z`, or canonical reduced `Q` strings).
3. **Zero-float exact verification (`verifyTensorIdentity`)**:
   - `GF2`: exact XOR parity over `Uint8Array`.
   - `Z`: arbitrary-precision `BigInt` tensor contraction.
   - `Q`: computes exact common denominators `du, dv, dw` per rank factor and global LCM `L`, reducing the rational identity to an exact `BigInt` check against `delta * L`.
4. **Deterministic commit & verdict (`report`)**: commits the exact judged blob SHA to `main` and delivers an HMAC-SHA256 signed verdict to Swarmdesk with the verified rank and addition count.
