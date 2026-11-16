#!/bin/bash
# Rehearsal of the nightly's cache-saving step against scratch repositories under /tmp (a local bare "origin", depth-1 clones
# like the runner, no network). It extracts the push block straight from .github/workflows/mood-engine.yml, so what runs here
# is what runs on GitHub. Main session only: the project hook bars subagents from any command with `git push`, even this one.
#
# Scenarios (14/10/2026):
#   A  main moved during the build, the caches changed      -> first push rejected, rebase, second push lands; origin/main has both commits
#   B  the 14/10 queue: the night saved mubi.json, then the run queued behind it (older base) changed another cache file
#      -> its push is rejected, the rebase carries it, the night's mubi.json survives on main next to the queued run's file
#   B2 same queue, but both touched the same one-line cache file -> conflict, skipped, and the night's mubi.json still survives
#   B3 a run whose caches did not change -> "Nothing to save", no push attempted, no 'second try' claimed
#   C  both sides edited the same line of a cache file      -> rebase conflict, aborted, "conflicts" message, origin/main unchanged
#   D  the run's cache file is not JSON and main moved       -> rebase ok, the JSON check refuses, origin/main unchanged
#   E  control, the old single-try form                      -> "Cache push skipped", the commit is lost
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
WF="$HERE/.github/workflows/mood-engine.yml"
R=/tmp/rehearse-cache-push; rm -rf "$R"; mkdir -p "$R"
awk '/^          if git push origin "HEAD/{f=1} f&&/^          fi$/{print "fi"; exit} f{sub(/^          /,""); print}' "$WF" > "$R/block.sh"
grep -q 'Cache pushed on the second try' "$R/block.sh" || { echo "could not extract the push block from the workflow"; exit 1; }
bash -n "$R/block.sh"
# What the step does between `git add` and the block: commit only when something changed.
save() { # save <clone> : stage cache/, commit if changed, run the block
  ( cd "$R/$1"; export BRANCH=main
    git add cache
    if git diff --cached --quiet; then echo "Nothing to save: the caches did not change in this run"; exit 0; fi
    git commit -qm "Update TMDB cache [skip ci]"
    bash -e "$R/block.sh" )
}
origin_log() { git -C "$R/origin.git" log --format=%s main | tr '\n' '|'; echo; }
mkjson() { printf '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5,\n  "f": 6,\n  "g": 7\n}\n' > "$1"; }
clone() { git clone -q --depth 1 --branch main "file://$R/origin.git" "$R/$1" 2>/dev/null; git -C "$R/$1" config user.name t; git -C "$R/$1" config user.email t@t; }

cd "$R"; git init -q --bare -b main origin.git
git clone -q origin.git seed 2>/dev/null; cd seed; git config user.name t; git config user.email t@t
mkdir cache; mkjson cache/mubi.json; echo '{"tmdb":0}' > cache/tmdb.json; echo base > base.txt
git add .; git commit -qm "base"; git branch -M main; git push -q origin main; cd "$R"
fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok: $3"; else echo "  FAIL: $3 (got: $1)"; fail=1; fi; }

echo "=== A: main moved, caches changed -> second push lands"
clone A_run; clone A_pr
( cd A_pr; echo feature > feature.txt; git add .; git commit -qm "A: PR reaches main"; git push -q origin HEAD:refs/heads/main )
( cd A_run; echo '{"tmdb":1}' > cache/tmdb.json )
out=$(save A_run 2>&1); echo "$out" | grep -E 'rejected|Cache pushed|skipped'
check "$(origin_log)" "Update TMDB cache [skip ci]|A: PR reaches main|base|" "origin/main holds the PR and the cache commit"
check "$(echo "$out" | grep -c 'Cache pushed on the second try')" "1" "says it was the second try"

echo "=== B: the 14/10 queue: night saves mubi.json; the queued run (older base) changed tmdb.json -> rebase carries it, the night's file survives"
clone B_queued            # checked out at the tip BEFORE the night's commit, like the run queued behind the nightly (started 6 s after it on 14/10)
clone B_night; ( cd B_night; python3 - <<'PY'
import json; p='cache/mubi.json'; d=json.load(open(p)); d['night']='74 confirmed'; json.dump(d, open(p,'w'), indent=2)
PY
)
save B_night >/dev/null 2>&1
( cd B_queued; echo '{"tmdb":"queued run"}' > cache/tmdb.json )
out=$(save B_queued 2>&1); echo "$out" | grep -E 'rejected|Cache pushed|skipped|Nothing'
check "$(echo "$out" | grep -c 'Cache pushed on the second try')" "1" "the queued run's cache lands on the second try"
check "$(git -C origin.git show main:cache/mubi.json | grep -c '74 confirmed')" "1" "the night's mubi.json is still on main"
check "$(git -C origin.git show main:cache/tmdb.json)" '{"tmdb":"queued run"}' "and the queued run's tmdb.json is there too"

echo "=== B2: same queue, both touched the same one-line file -> conflict, skipped, the night's mubi.json still survives"
clone B2_queued
clone B2_night; ( cd B2_night; echo '{"friends":"night"}' > cache/friends.json; python3 - <<'PY'
import json; p='cache/mubi.json'; d=json.load(open(p)); d['night2']='more'; json.dump(d, open(p,'w'), indent=2)
PY
)
save B2_night >/dev/null 2>&1
( cd B2_queued; echo '{"friends":"queued"}' > cache/friends.json )
out=$(save B2_queued 2>&1); echo "$out" | grep -E 'rejected|Cache pushed|skipped|Nothing'
check "$(echo "$out" | grep -c 'conflicts with what reached main')" "1" "the conflict message"
check "$(git -C origin.git show main:cache/mubi.json | grep -c 'night2')" "1" "the night's mubi.json is still on main"
check "$(git -C origin.git show main:cache/friends.json)" '{"friends":"night"}' "and the night's friends.json was not overwritten"

echo "=== B3: a run whose caches did not change -> nothing saved, no second try claimed"
clone B3_run
out=$(save B3_run 2>&1); echo "$out"
check "$out" "Nothing to save: the caches did not change in this run" "nothing to save"

echo "=== C: both sides edited the same line -> rebase conflict, aborted, origin/main unchanged"
before=$(origin_log)
clone C_run; clone C_other
( cd C_other; sed -i.bak 's/"d": 4/"d": 40/' cache/mubi.json; rm cache/mubi.json.bak; git add cache; git commit -qm "other: d=40"; git push -q origin HEAD:refs/heads/main )
( cd C_run; sed -i.bak 's/"d": 4/"d": 44/' cache/mubi.json; rm cache/mubi.json.bak )
out=$(save C_run 2>&1); echo "$out" | grep -E 'rejected|skipped|pushed'
check "$(echo "$out" | grep -c 'conflicts with what reached main')" "1" "the conflict message"
check "$(origin_log)" "other: d=40|$before" "origin/main gained only the other commit"
check "$(git -C C_run status --porcelain | wc -l | tr -d ' ')" "0" "the clone is clean after the abort"

echo "=== D: the run's cache file is not JSON and main moved -> the JSON check refuses"
before=$(origin_log)
clone D_run; clone D_pr
( cd D_pr; echo more > more.txt; git add .; git commit -qm "D: PR reaches main"; git push -q origin HEAD:refs/heads/main )
( cd D_run; printf '{"tmdb": 2,\n' > cache/tmdb.json )
out=$(save D_run 2>&1); echo "$out" | grep -E 'rejected|skipped|pushed'
check "$(echo "$out" | grep -c 'no longer valid JSON: cache/tmdb.json')" "1" "names the broken file"
check "$(origin_log)" "D: PR reaches main|$before" "origin/main gained only the PR"

echo "=== E: control, the old single-try form -> the cache commit is lost"
before=$(origin_log)
clone E_run; clone E_pr
( cd E_pr; echo again > again.txt; git add .; git commit -qm "E: PR reaches main"; git push -q origin HEAD:refs/heads/main )
( cd E_run; echo '{"tmdb":5}' > cache/tmdb.json; git add cache; git commit -qm "Update TMDB cache [skip ci]"
  BRANCH=main; git push origin "HEAD:refs/heads/$BRANCH" 2>/dev/null || echo "Cache push skipped" )
check "$(origin_log)" "E: PR reaches main|$before" "the old form loses the cache commit"

[ $fail = 0 ] && echo "REHEARSAL PASSED (A-D) AND THE CONTROL FAILED AS EXPECTED (E)" || { echo "REHEARSAL FAILED"; exit 1; }
