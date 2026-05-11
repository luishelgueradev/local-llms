---
status: diagnosed
trigger: "Phase 1 SC2 acceptance grep returns 3 (not 0) on compose.yml — false positive from anti-pattern strings inside header comments"
created: 2026-05-11T18:30:00Z
updated: 2026-05-11T18:45:00Z
---

## Current Focus

hypothesis: SC2's literal regex `(:latest|runtime: nvidia|gpus: all)` matches three header-comment lines (9, 18, 19) in compose.yml that *document* the anti-patterns being banned. The grep is not comment-aware, so it reports a false positive. The substantive Compose config has zero matches.
test: Reproduce on disk: `grep -nE '(:latest|runtime: nvidia|gpus: all)' compose.yml` (raw) vs. `grep -vE '^[[:space:]]*#' compose.yml | grep -cE '(:latest|runtime: nvidia|gpus: all)'` (comment-excluded).
expecting: Raw grep = 3 matches at lines 9/18/19, all on comment lines; comment-excluded grep = 0.
next_action: Diagnosis complete — return ROOT CAUSE FOUND. Do NOT fix (per goal: find_root_cause_only). plan-phase --gaps will apply fix.

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
