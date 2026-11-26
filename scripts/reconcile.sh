#!/usr/bin/env bash
# Re-sends recent verified commits on main to Swarmdesk POST /api/verdicts idempotently.
set -euo pipefail
: "${REPO:?}" "${GH_TOKEN:?}" "${DEFAULT_BRANCH:?}" "${SWARMDESK_URL:?}" "${VERDICT_SECRET:?}"
here=$(cd "$(dirname "$0")" && pwd)
PROBLEM="${PROBLEM:-matrix-mult}"
LIMIT="${LIMIT:-30}"
printf '%s' "$LIMIT" | grep -Eqx '[1-9][0-9]?' || { echo "LIMIT must be 1 to 99"; exit 2; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sent=0
failed=0
LOGIN='^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
WHEN='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
TITLE='^step-([0-9]+): accepted ([a-z0-9_]{1,48}) by ([A-Za-z0-9][A-Za-z0-9-]{0,38})$'

gh api "repos/$REPO/commits?sha=$DEFAULT_BRANCH&per_page=$LIMIT" \
  --jq '.[] | select((.parents | length) == 1) | .sha' | tac > "$work/single.txt"

while read -r sha; do
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
  gh api "repos/$REPO/commits/$sha" > "$work/commit.json" 2>/dev/null || continue
  proof=$(jq -r '[
      .author.login == "github-actions[bot]",
      .committer.login == "web-flow",
      .commit.verification.verified == true,
      (.parents | length) == 1,
      (.files | length) == 1
    ] | all' "$work/commit.json")
  [ "$proof" = true ] || continue

  target_file=$(jq -r '.files[0].filename // ""' "$work/commit.json")
  [[ "$target_file" =~ ^targets/[a-z0-9_]{1,48}\.json$ ]] || continue
  merged_at=$(jq -r '.commit.committer.date' "$work/commit.json")
  [[ "$merged_at" =~ $WHEN ]] || continue

  title=$(jq -r '.commit.message' "$work/commit.json" | sed -n 1p)
  [[ "$title" =~ $TITLE ]] || continue
  step="${BASH_REMATCH[1]}"
  target="${BASH_REMATCH[2]}"
  author="${BASH_REMATCH[3]}"
  [[ "$step" =~ ^[1-9][0-9]{0,8}$ && "$author" =~ $LOGIN ]] || continue

  rank=$(gh api "repos/$REPO/contents/$target_file?ref=$sha" --jq '.content' | base64 -d | jq -r '.rank')
  [[ "$rank" =~ ^[0-9]+$ ]] || continue

  jq -cn --arg problem "$PROBLEM" --arg head_sha "$sha" --arg author "$author" \
    --argjson step "$step" --arg target "$target" --argjson metric "$rank" --arg merged_at "$merged_at" \
    '{problem: $problem, pr: $step, head_sha: $head_sha, author: $author, step: $step, target: $target,
      verdict: "ACCEPTED", reason: "", reason_code: "", resolution: "improved",
      metric_value: $metric, holder_value: null, proof_lines: 0,
      merged: true, merged_at: $merged_at, run_url: ""}' > "$work/payload.json"
  signature=$(printf '%s' "$(jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {sent_at: $at}' "$work/payload.json")" \
    | openssl dgst -sha256 -hmac "$VERDICT_SECRET" -hex | sed 's/^.* //')
  body=$(jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {sent_at: $at}' "$work/payload.json")
  code=$(curl -sS --proto '=https' --max-time 20 -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H "X-Swarmdesk-Signature: sha256=$signature" \
    --data-binary "$body" "$SWARMDESK_URL/api/verdicts")
  if [ "$code" = 200 ]; then sent=$((sent + 1)); else failed=$((failed + 1)); fi
done < "$work/single.txt"

echo "records sent: $sent, not delivered: $failed"
[ "$failed" = 0 ]
