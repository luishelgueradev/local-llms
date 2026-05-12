---
status: diagnosed
trigger: "Phase 1 SC2 acceptance grep returns 3 (not 0) on compose.yml — false positive from anti-pattern strings inside header comments"
created: 2026-05-11T18:30:00Z
updated: 2026-05-11T21:45:00Z
reopened: 2026-05-11T21:30:00Z  # re-opened to validate Plan 01-06's proposed fix before /gsd-execute-phase, mirroring the preflight session's validation pass
validated: 2026-05-11T21:45:00Z  # Plan 01-06 validated — Q1/Q3 hold, Q2 partial (01-UAT.md line 101 ref confirmed stale; executor must use content-anchored locates for that file)
---

## Current Focus

hypothesis: Plan 01-06's two-task fix (rephrase compose.yml lines 9/18/19 + harden SC2 grep in the planning docs) is safe to execute as-written. Three lightweight predictions:

  (Q1) The proposed rephrased comment lines from Plan 01-06 Task 1 — when written to a SANDBOX COPY of compose.yml — make `grep -cE '(:latest|runtime: nvidia|gpus: all)' <copy>` return 0. (The literal patterns disappear because the proposed phrasings drop the colons / quote-wrap the bare terms.)

  (Q2) The line numbers Plan 01-06 Task 2 cites for the SC2 grep restatements are correct against the LIVE files:
    - 01-03-PLAN.md lines 354 and 382 → should contain `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` or a close variant
    - 01-04-PLAN.md line 292 → should contain a variant of the same grep
    - 01-UAT.md line 39 → should contain the SC2 grep in test 3's `expected:` field
    The plan-checker already flagged that 01-06's "DO NOT EDIT LINE 101" of 01-UAT.md is stale (real SC2 narrative is at line 140 in the current file). Confirm whether the OTHER cited line numbers are correct or also drifted.

  (Q3) The proposed rephrasings preserve documentation intent: INFRA-04 attribution stays on line 9, "DO NOT" framing stays on lines 18/19, the three key terms (latest, runtime nvidia, gpus all) are still recognizable at-a-glance. Subjective but worth a one-line eyeball before merging.

test:
  (T-Q1) `cp compose.yml /tmp/compose-fix-dryrun.yml`, then use `sed -i` to swap the three lines per Plan 01-06's literal proposals, then run the raw SC2 grep against the copy. Predict: returns 0. Also re-run the comment-aware grep to confirm it stays at 0.
  (T-Q2) For each of the four cited locations, `sed -n '<line>p' <file>` and visually verify the line contains the canonical SC2 grep or a close variant. Record any line drift.
  (T-Q3) `diff -u` the original compose.yml header (lines 1-25) against the rephrased version; eyeball the diff to confirm intent preservation.

expecting: All three predictions hold. If Q2 surfaces line drift in 01-03-PLAN.md or 01-04-PLAN.md (in addition to the already-known 01-UAT.md drift), append it to the operational notes for execute-phase so the executor uses content-anchored locates instead of line numbers.

next_action: Execute T-Q1, T-Q2, T-Q3 as zero-source-change sandbox tests (sandbox copy under /tmp for T-Q1; read-only `sed -n` for T-Q2; visual diff for T-Q3). DO NOT modify compose.yml, 01-03-PLAN.md, 01-04-PLAN.md, or 01-UAT.md — the actual edits belong to /gsd-execute-phase. Record per-test verdicts in the Evidence section and end with `## VALIDATION COMPLETE` summarizing whether Plan 01-06 is safe to execute as-written.

## Symptoms

expected: `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` returns 0 (Phase 1 SC2 acceptance from ROADMAP.md / 01-03-PLAN.md line 354 / 01-UAT.md test 3).
actual: Returns 3.
errors: |
  $ grep -nE '(:latest|runtime: nvidia|gpus: all)' compose.yml
  9:#   - pinned image tags (no :latest — INFRA-04)
  18:# DO NOT use `runtime: nvidia` (legacy form, on the standing rejection list).
  19:# DO NOT use `gpus: all` shorthand (Compose-version-fragile).
reproduction: |
  1. cd to repo root
  2. Run `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml`
  3. Observe count = 3, not 0
  4. Confirm matches are all comment lines: `grep -nE '(:latest|runtime: nvidia|gpus: all)' compose.yml`
  5. Confirm comment-excluded form returns 0: `grep -vE '^[[:space:]]*#' compose.yml | grep -cE '(:latest|runtime: nvidia|gpus: all)'`
  6. Confirm substantive config is clean: `docker compose config` shows `nvidia/cuda:12.6.0-base-ubuntu24.04`, `ollama/ollama:0.5.7`, modern `deploy.resources.reservations.devices` syntax, no `runtime: nvidia`, no `gpus: all`.
started: 2026-05-11 during Phase 1 UAT (test 3 / SC2). The same false-positive class has been hit twice before in Phase 1 (Plan 02 and Plan 04) for different files — neither fix was propagated to the SC2 grep itself.

## Eliminated

- hypothesis: "The Compose configuration substantively contains a banned anti-pattern (real `:latest` tag, real `runtime: nvidia`, or real `gpus: all` directive)."
  evidence: |
    `docker compose config` (snapshot in 01-03-SUMMARY.md lines 111-192) and the raw compose.yml (162 lines, read in full) show every image tag is pinned (`nvidia/cuda:12.6.0-base-ubuntu24.04` line 58, `ollama/ollama:0.5.7` line 89), GPU reservation uses `deploy.resources.reservations.devices` (lines 22-28), zero `runtime:` directives, zero `gpus:` directives. The three grep matches are all comment lines (`#` first non-space character).
  timestamp: 2026-05-11T18:35:00Z

- hypothesis: "The SC2 grep is wired into an automated/CI test that will need updating."
  evidence: |
    Comprehensive grep across the repo: `grep -rn 'grep -cE' .planning/` and `grep -rn '(:latest|runtime: nvidia|gpus: all)' .planning/ README.md bin/` shows the literal SC2 grep appears only in prose inside `.planning/phases/01-gpu-compose-foundation/{01-03-PLAN.md, 01-UAT.md, 01-04-PLAN.md, 01-04-SUMMARY.md, 01-03-SUMMARY.md}`. No bash script under `bin/`, no `package.json`, no GitHub Actions workflow, no `Makefile` runs it. It is documentation-only — a manually-invoked acceptance check.
  timestamp: 2026-05-11T18:36:00Z

## Evidence

- timestamp: 2026-05-11T18:31:00Z
  checked: |
    compose.yml lines 1-50 (full header comment block + x-gpu anchor + networks block)
  found: |
    Line 9: `#   - pinned image tags (no :latest — INFRA-04)`
    Line 18: `# DO NOT use \`runtime: nvidia\` (legacy form, on the standing rejection list).`
    Line 19: `# DO NOT use \`gpus: all\` shorthand (Compose-version-fragile).`
    All three lines begin with `#` (line 9 is indented two spaces then `#`, lines 18 and 19 are flush-left `#`). They are pedagogical comments documenting the standing anti-pattern list inside the file's header — the same list catalogued in `.planning/STATE.md` lines 76-86 ("Standing Anti-Patterns to Reject").
  implication: |
    The comments themselves are valuable as in-file documentation (anyone reading compose.yml learns the rules without leaving the file). Removing them outright would degrade the file. The fix must preserve the *meaning* while changing the *literal text* so the grep returns 0.

- timestamp: 2026-05-11T18:32:00Z
  checked: |
    Where the SC2 grep is defined in the repo. Searched: `grep -rn 'grep -cE' .planning/`, `grep -rn '(:latest|runtime: nvidia|gpus: all)' .planning/ README.md`, `find . -name "*.sh" -path "*/bin/*"`, `find . -name "package.json" -maxdepth 3`.
  found: |
    The literal grep `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` appears in:
      - .planning/phases/01-gpu-compose-foundation/01-03-PLAN.md line 354 (Task 1 acceptance) and line 382 (final "done when" block) — THE SOURCE OF TRUTH for this acceptance check
      - .planning/phases/01-gpu-compose-foundation/01-UAT.md line 39 (test 3 "expected") and line 101 (gap "reason")
      - .planning/phases/01-gpu-compose-foundation/01-04-PLAN.md line 292 (slight variant with line-anchored regex)
      - .planning/phases/01-gpu-compose-foundation/01-04-SUMMARY.md line 200 (SC2 verification table)
      - .planning/phases/01-gpu-compose-foundation/01-03-SUMMARY.md line 200 (qualifies "non-comment lines" — admits the comment-exclude variant ran during Plan 03 verification but did NOT propagate back to the plan text)
    ROADMAP.md (.planning/ROADMAP.md) Phase 1 SC2 (line 33) is prose only — it says "no service uses the legacy `runtime: nvidia` form and no service uses a `:latest` image tag" with NO grep command attached.
    No script under `bin/` runs the grep. No `package.json` exists yet (Phase 2 will introduce the router). No CI workflow exists yet. No `Makefile`. The grep is a documentation-only acceptance check executed manually during UAT.
  implication: |
    The fix surface is narrow: rewriting the literal grep would require touching `01-03-PLAN.md`, `01-04-PLAN.md`, `01-UAT.md` (and possibly `01-04-SUMMARY.md` retroactively for accuracy). Rewriting compose.yml comment text only touches one file. The SC2 grep is the SOURCE definition; the prose SC2 in ROADMAP.md is unaffected by either fix option.

- timestamp: 2026-05-11T18:37:00Z
  checked: |
    Precedent — how Plan 02 and Plan 04 fixed the same class of bug.
  found: |
    Plan 02 SUMMARY.md ("Auto-fixed Issue 2 — Avoided acceptance criteria false positive on remediation hints"):
      Fix: REPHRASED the remediation hint strings inside bin/preflight-gpu.sh ("Rephrased hints to reference the NVIDIA Container Toolkit documentation URL instead of printing the exact commands. Semantic content preserved; acceptance criterion satisfied.")
      Verification used: `grep -vE '^[[:space:]]*#' bin/preflight-gpu.sh | grep -cE '...'` == 0 — note: this comment-aware form was used in the VERIFICATION command, but the plan acceptance criterion itself was rewritten to USE this comment-aware form (PLAN.md line 235, 246: the `<automated>` block uses `grep -vE '^[[:space:]]*#' bin/preflight-gpu.sh | grep -cE '...'`). So Plan 02 ACTUALLY used a HYBRID: rephrased source AND comment-aware grep, with the grep updated in the plan.
    Plan 04 SUMMARY.md ("Auto-fixed Issue 1a — tokens/sec pattern in comment"):
      Fix: REPHRASED comment "# No tokens/sec floor — D-10" to "# No throughput floor — generation speed varies too much across hardware (D-10)" — option (a), source rephrase. Mirrors Plan 02.
    Plan 04 SUMMARY.md ("Auto-fixed Issue 1b — ollama pull in non-comment error message"):
      Fix: Constructed `PULL_CMD` variable so the literal source text doesn't contain `ollama pull` even though the runtime output does — option (a), source rephrase. The runtime user experience is unchanged; only the source bytes that grep scans differ.
    Pattern: Plan 02 and Plan 04 BOTH chose option (a) for the FILES being scanned. Plan 02 additionally hardened the GREP itself to be comment-aware in its plan acceptance criterion (so future plan-readers don't fall into the same trap). Plan 03 did NOT propagate either fix to compose.yml or its own grep — leaving SC2 as the only un-hardened acceptance check.
  implication: |
    Precedent strongly favors option (a) source rephrase as the primary fix (consistent with Plans 02 and 04 patterns). However, Plan 02 set a SECONDARY precedent of also hardening the grep itself (`grep -vE '^[[:space:]]*#' file | grep -cE ...`) so the same trap can't snare the next person. A defensible, fully-consistent fix combines both: rephrase the three comment lines in compose.yml AND update the grep in 01-03-PLAN.md / 01-UAT.md to the comment-aware form. This is the highest-belt-and-suspenders option and matches the cumulative precedent of Plans 02+04 better than either approach alone.

- timestamp: 2026-05-11T18:40:00Z
  checked: |
    Verify that the comment-aware grep actually returns 0 against compose.yml as-is (i.e., without changing the source).
  found: |
    `grep -vE '^[[:space:]]*#' compose.yml | grep -cE '(:latest|runtime: nvidia|gpus: all)'` returns 0.
    So option (b) alone — change ONLY the grep, leave compose.yml comments intact — would also fix the symptom without any compose.yml edit. The semantic content of the SC2 check ("no anti-patterns in compose.yml's actual config") is satisfied by either option.
  implication: |
    Option (b) is a one-line touch in three planning docs (01-03-PLAN.md line 354+382, 01-UAT.md line 39, 01-04-PLAN.md line 292). Option (a) is a multi-line rewrite of compose.yml's header comment that has to preserve the pedagogical intent. Option (a)+(b) combined is the most defensive and matches Plan 02's pattern most closely.

- timestamp: 2026-05-11T21:35:00Z
  test_id: T-Q1
  checked: |
    Sandbox dry-run of Plan 01-06 Task 1's literal rephrasings on `/tmp/compose-fix-dryrun.yml`. Commands:
      $ cp /home/luis/proyectos/local-llms/compose.yml /tmp/compose-fix-dryrun.yml
      $ wc -l /tmp/compose-fix-dryrun.yml /home/luis/proyectos/local-llms/compose.yml   # both 161
      $ sed -n '9p;18p;19p' /tmp/compose-fix-dryrun.yml   # confirmed pre-edit content matches the debug file
      $ sed -i '9c\#   - pinned image tags (never use the floating "latest" form — INFRA-04)' /tmp/compose-fix-dryrun.yml
      $ sed -i '18c\# DO NOT use the legacy "runtime nvidia" Compose directive (on the standing rejection list).' /tmp/compose-fix-dryrun.yml
      $ sed -i '19c\# DO NOT use the "gpus all" shorthand (Compose-version-fragile).' /tmp/compose-fix-dryrun.yml
      $ grep -cE '(:latest|runtime: nvidia|gpus: all)' /tmp/compose-fix-dryrun.yml
      $ grep -nE '(:latest|runtime: nvidia|gpus: all)' /tmp/compose-fix-dryrun.yml
      $ grep -vE '^[[:space:]]*#' /tmp/compose-fix-dryrun.yml | grep -cE '(:latest|runtime: nvidia|gpus: all)'
      $ wc -l /tmp/compose-fix-dryrun.yml /home/luis/proyectos/local-llms/compose.yml
  found: |
    Pre-edit sandbox lines 9/18/19 matched the live compose.yml verbatim.
    Post-edit sandbox lines 9/18/19 read:
        #   - pinned image tags (never use the floating "latest" form — INFRA-04)
        # DO NOT use the legacy "runtime nvidia" Compose directive (on the standing rejection list).
        # DO NOT use the "gpus all" shorthand (Compose-version-fragile).
    `grep -cE '(:latest|runtime: nvidia|gpus: all)' /tmp/compose-fix-dryrun.yml` returned 0.
    `grep -nE '(:latest|runtime: nvidia|gpus: all)' /tmp/compose-fix-dryrun.yml` exited with status 1 (no matches printed).
    `grep -vE '^[[:space:]]*#' /tmp/compose-fix-dryrun.yml | grep -cE '(:latest|runtime: nvidia|gpus: all)'` returned 0.
    Line count: 161 → 161 (delta +0).
  implication: |
    Q1 HOLDS. Plan 01-06 Task 1's literal rephrasings, applied via `sed -i Nc\...`, make the load-bearing SC2 grep return 0. The comment-aware form continues to return 0 (no regression in substantive-config cleanliness). The byte-level line count is preserved.

- timestamp: 2026-05-11T21:37:00Z
  test_id: T-Q2
  checked: |
    Read-only `sed -n` audit of the four cited line numbers in Plan 01-06 Task 2, plus the plan-checker's already-flagged 01-UAT.md line-101-vs-140 drift.
    Commands:
      $ sed -n '354p' .planning/phases/01-gpu-compose-foundation/01-03-PLAN.md
      $ sed -n '382p' .planning/phases/01-gpu-compose-foundation/01-03-PLAN.md
      $ sed -n '292p' .planning/phases/01-gpu-compose-foundation/01-04-PLAN.md
      $ sed -n '39p'  .planning/phases/01-gpu-compose-foundation/01-UAT.md
      $ sed -n '101p' .planning/phases/01-gpu-compose-foundation/01-UAT.md
      $ sed -n '140p' .planning/phases/01-gpu-compose-foundation/01-UAT.md
  found: |
    01-03-PLAN.md:354 →
      `4. **No anti-patterns:** \`grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml\` returns 0.`
      CORRECT — exact literal canonical SC2 grep.
    01-03-PLAN.md:382 →
      `- Confirmation that \`grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml\` returns 0`
      CORRECT — exact literal canonical SC2 grep (inside `<output>` SUMMARY template).
    01-04-PLAN.md:292 →
      `    - [ ] SC2: \`docker compose config\` shows the \`x-gpu\` anchor expanded into the \`ollama\` service; \`grep -cE '(:latest|^[[:space:]]*runtime:[[:space:]]*nvidia|^[[:space:]]*gpus:[[:space:]]*all)' compose.yml\` returns 0.`
      CORRECT — line-anchored variant of the SC2 grep, exactly as Plan 01-06 Task 2 Edit C describes.
    01-UAT.md:39 →
      `expected: \`docker compose config\` shows every GPU service references the same \`x-gpu\` YAML anchor (driver: nvidia, count: all, capabilities include \`gpu\`). No service uses the legacy \`runtime: nvidia\` form. No service uses \`:latest\`. Verify with: \`grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml\` returns 0.`
      CORRECT — final clause contains the literal canonical SC2 grep; Plan 01-06 Edit D targets exactly this clause.
    01-UAT.md:101 →
      `      - Two leftover \`.preflight-state.json.tmp.NNNNN\` files (PIDs 64770 and 65114) are abandoned in \`/srv/local-llms/\`. The tmp-then-rename pattern lacks a \`trap\` to clean up on early exit / cancelled mv.`
      DRIFTED — this line is preflight-state-file content (a Plan 01-05 gap narrative), NOT the SC2 gap `reason:` narrative Plan 01-06 claims. The plan-checker's flag is confirmed.
    01-UAT.md:140 →
      `    \`grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml\` returns 3, not 0. All 3 matches are header comments at lines 9, 18, 19 documenting the anti-patterns ("no :latest", "DO NOT use runtime: nvidia", "DO NOT use gpus: all"). The substantive config is clean: pinned image tags, modern \`deploy.resources.reservations.devices\` syntax, x-gpu anchor merged. Same false-positive pattern as Phase 1 Plan 02 and Plan 04 ("acceptance-criteria-vs-implementation contradiction"). Fix: either exclude comment lines in the grep (\`grep -vE '^[[:space:]]*#' compose.yml | grep -cE ...\`) or rephrase the comments to avoid the literal patterns.`
      CORRECT — this is the real SC2 gap `reason:` narrative the plan-checker said lives at line 140 (not 101).
  implication: |
    Q2 PARTIALLY HOLDS. Three of the four cited line numbers (01-03-PLAN.md:354, 01-03-PLAN.md:382, 01-04-PLAN.md:292, 01-UAT.md:39) are CORRECT against the live files. The fourth claim — Plan 01-06's `**DO NOT EDIT LINE 101.**` directive in Edit D — is wrong: line 101 currently holds preflight-state-file content (a Plan 01-05 gap narrative), not the SC2 `reason:` narrative. The real SC2 `reason:` narrative is at line 140. The plan-checker's pre-existing flag is confirmed by direct inspection.
    Operational consequence: Plan 01-06's Edit D as written is still safe — it instructs the executor to update line 39 (which is correct) and to LEAVE line 101 ALONE. Since line 101 is not SC2 content, leaving it alone is harmless to the SC2 fix. However, the rationale Plan 01-06 gives for "DO NOT EDIT LINE 101" is wrong (it claims line 101 is the SC2 `reason:` field; it isn't). The executor MUST NOT edit line 101 anyway (it belongs to a different gap), but the executor MUST also NOT edit line 140 (the real SC2 `reason:` narrative) for the same audit-trail reason Plan 01-06 cites for line 101. Recommend: executor uses content-anchored locates (`grep -n "All 3 matches are header comments"` and `grep -n "grep -cE '(:latest"`) instead of trusting Plan 01-06's line numbers blindly.

- timestamp: 2026-05-11T21:38:00Z
  test_id: T-Q3
  checked: |
    `diff -u <(sed -n '1,25p' compose.yml) <(sed -n '1,25p' /tmp/compose-fix-dryrun.yml)`
  found: |
    The diff is exactly three line-for-line replacements at lines 9, 18, 19 — no surrounding lines touched, no insertions, no deletions. Verbatim diff hunks:
      -#   - pinned image tags (no :latest — INFRA-04)
      +#   - pinned image tags (never use the floating "latest" form — INFRA-04)
      -# DO NOT use `runtime: nvidia` (legacy form, on the standing rejection list).
      -# DO NOT use `gpus: all` shorthand (Compose-version-fragile).
      +# DO NOT use the legacy "runtime nvidia" Compose directive (on the standing rejection list).
      +# DO NOT use the "gpus all" shorthand (Compose-version-fragile).
  implication: |
    Q3 HOLDS. (a) INFRA-04 attribution is preserved at the tail of line 9. (b) The "DO NOT" framing is preserved at the head of lines 18 and 19. (c) The three key terms remain recognizable at-a-glance — `"latest"`, `"runtime nvidia"`, `"gpus all"` all appear as quoted phrases so a reader of compose.yml still learns the anti-pattern rules without leaving the file. The only semantic difference is the prose form: colons are gone (so the literal regex no longer matches) and backticks have been replaced by double-quotes (cosmetic only — quotes are slightly more idiomatic English).

## VALIDATION COMPLETE

Per-prediction verdict:

- **Q1 (sandbox grep returns 0 after rephrasing):** HOLDS. The raw SC2 grep `grep -cE '(:latest|runtime: nvidia|gpus: all)' /tmp/compose-fix-dryrun.yml` returns 0 after applying Plan 01-06 Task 1's literal rephrasings. The comment-aware variant continues to return 0 (no regression). Line count is byte-equivalent (161 → 161, delta +0).
- **Q2 (cited line numbers are correct against the live files):** PARTIALLY HOLDS. Three of four are correct (01-03-PLAN.md:354, 01-03-PLAN.md:382, 01-04-PLAN.md:292, 01-UAT.md:39). The plan-checker's pre-existing flag is CONFIRMED: 01-UAT.md line 101 holds Plan 01-05 preflight-state-file content, NOT SC2 content; the real SC2 `reason:` narrative is at line 140.
- **Q3 (rephrasings preserve documentation intent):** HOLDS. INFRA-04 attribution is preserved on line 9, "DO NOT" framing is preserved on lines 18 and 19, and the three key anti-pattern terms remain recognizable at-a-glance as quoted English phrases (`"latest"`, `"runtime nvidia"`, `"gpus all"`).

**Is Plan 01-06 safe to execute as-written?** YES, with one operational caveat.

The combined fix (rephrase compose.yml lines 9/18/19 + harden the SC2 grep in three planning docs) is correct and safe:

- Task 1 (`compose.yml` rephrasings) is verified by direct sandbox: the failing SC2 grep returns 0 after the edit, the comment-aware grep continues to return 0, and the documentation intent is preserved. The executor can apply the three `sed -i Nc\...` edits exactly as Plan 01-06 Action specifies — they have been tested against `/tmp/compose-fix-dryrun.yml` and produce the expected outcome with zero side effects on file structure or line count.
- Task 2 (planning-doc grep hardening) is verified by line-by-line audit: the cited line numbers for the FORWARD-LOOKING edits (01-03-PLAN.md:354, 01-03-PLAN.md:382, 01-04-PLAN.md:292, 01-UAT.md:39) are all correct against the live files. The executor can target these lines directly.

**Operational caveat (line-number drift in Plan 01-06 Task 2 Edit D's rationale):**

Plan 01-06 Edit D's directive `**DO NOT EDIT LINE 101.**` is based on the wrong premise — it claims line 101 is the SC2 gap `reason:` narrative, but line 101 currently holds Plan 01-05 preflight-state-file content (a different gap entirely). The real SC2 `reason:` narrative — the line Plan 01-06 actually wants to protect from rewriting — is at line 140.

This does NOT change the executor's behavior: line 101 should NOT be edited (it belongs to a different gap), AND line 140 should also NOT be edited (it is the historical SC2 `reason:` narrative, exactly the kind of audit-trail content Plan 01-06 cites as the justification for not editing). The executor's only actual SC2 edit in 01-UAT.md is line 39.

**Recommendation for `/gsd-execute-phase 01 --gaps-only`:**

Use content-anchored locates rather than trusting Plan 01-06's line numbers blindly. Specifically, before editing 01-UAT.md, run:

  $ grep -n "Verify with: \`grep -cE" .planning/phases/01-gpu-compose-foundation/01-UAT.md
  $ grep -n "All 3 matches are header comments" .planning/phases/01-gpu-compose-foundation/01-UAT.md

The first will find the `expected:` clause to edit (the forward-looking test 3 line). The second will find the historical SC2 `reason:` narrative — leave that line alone for the same audit-trail reason Plan 01-06 cites. The other planning-doc edits in 01-03-PLAN.md and 01-04-PLAN.md can use Plan 01-06's line numbers directly — they were verified correct.

## Resolution

root_cause: |
  Phase 1 SC2's literal acceptance regex `(:latest|runtime: nvidia|gpus: all)` is not comment-aware. The current compose.yml correctly documents the standing anti-pattern list in its file header (lines 1-13) and inside the `x-gpu` anchor block (lines 17-20). Three of those documentation lines (9, 18, 19) contain the exact literal strings the grep is hunting for, even though they are obviously comments (each starts with `#` after optional whitespace). The grep counts them as matches, returning 3. The substantive Compose configuration — image tags, GPU reservation syntax — is clean (zero matches in non-comment lines, confirmed by `grep -vE '^[[:space:]]*#' compose.yml | grep -cE '...'` == 0 and by `docker compose config` output snapshot in 01-03-SUMMARY.md lines 111-192).

  This is the same false-positive class Phase 1 Plan 02 and Plan 04 hit on `bin/preflight-gpu.sh` and `bin/smoke-test-gpu.sh` respectively. The fix pattern was established twice in those plans and was NOT propagated to SC2.

  PRECISE SOURCE OF THE GREP: `.planning/phases/01-gpu-compose-foundation/01-03-PLAN.md` line 354 ("4. **No anti-patterns:** `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` returns 0.") and line 382 (Task 1 final "done when" block). This is the canonical written-down form. Restated in 01-UAT.md line 39, 01-04-PLAN.md line 292 (variant), 01-04-SUMMARY.md line 200. The grep has no executable shrinkwrap — no bin/ script, no package.json script, no CI workflow runs it. It is prose-only, manually invoked during UAT.

  THE THREE OFFENDING COMMENT LINES (verbatim from compose.yml):
    Line 9:  `#   - pinned image tags (no :latest — INFRA-04)`
    Line 18: `# DO NOT use \`runtime: nvidia\` (legacy form, on the standing rejection list).`
    Line 19: `# DO NOT use \`gpus: all\` shorthand (Compose-version-fragile).`

  WHICH FIX OPTION FITS THE PRECEDENT: Plans 02 and 04 BOTH primarily chose option (a) — rephrase the source so the literal pattern doesn't appear in scanned text. Plan 02 ADDITIONALLY hardened the grep itself in its plan acceptance criterion (line 235, 246 of 01-02-PLAN.md use `grep -vE '^[[:space:]]*#' bin/preflight-gpu.sh | grep -cE '...'`). The cumulative precedent points to a combined fix: rephrase the three compose.yml comments AND update the SC2 grep to the comment-aware form everywhere it's written down. That's the only outcome that is fully consistent with the project's two prior decisions on this exact bug class.

fix: ""
verification: ""
files_changed: []
