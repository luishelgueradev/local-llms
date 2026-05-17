/**
 * Plan 09-01 (OPS-01) — helper invoked by bin/gc-models.sh.
 *
 * stdin   : one relative path per line, NEWLINE-terminated (paths
 *           containing literal newlines are unsupported — `find` could
 *           in theory emit them, but the gc-models.sh candidate emitter
 *           never does).
 * argv[2] : absolute path to router/models.yaml.
 * stdout  : one RECORD per input. Fields separated by ASCII Record
 *           Separator (0x1e). Records terminated by NUL (0x00):
 *             <referenced 0|1> RS <reason or empty> RS <relPath> NUL
 *
 *           Switched from TAB-separated to RS+NUL in WR-04: paths may
 *           legally contain TAB characters (rare but possible under
 *           `find`-emitted output), which would corrupt the downstream
 *           classification → mv pipeline. NUL is the single octet POSIX
 *           guarantees cannot appear in a filename, so it is the only
 *           safe record terminator. ASCII RS (0x1e) is unlikely-but-not-
 *           impossible in a filename — practically safe for the field
 *           separator, and bash can iterate via `read -d ''` (which
 *           reads until the next NUL) with `IFS=$'\x1e'` for the split.
 *
 *           Important bash detail (bash-hackers RFAQ #100): `read`
 *           cannot use NUL as a field separator (it silently strips
 *           NULs); we therefore make NUL the OUTER (record) separator
 *           and use RS as the inner (field) separator.
 *
 * Exits non-zero on YAML parse failure / missing argv[2] / read error.
 * Designed to be invoked from the bash GC script via:
 *   node_modules/.bin/tsx scripts/gc-classify.ts /abs/path/router/models.yaml < candidates.txt
 *
 * Why a file (instead of `tsx --eval`): tsx resolves module specifiers in
 * `--eval` against the CWD, not the script — the import path drifts when the
 * GC script is invoked from anywhere other than the router/ dir. A real file
 * gives us a stable __dirname-relative import.
 */
import { readFileSync } from 'node:fs';
import {
  collectReferencedTokens,
  classifyCandidate,
} from '../src/ops/gcModels.ts';

const yamlPath = process.argv[2];
if (!yamlPath) {
  process.stderr.write('gc-classify: missing argv[2] (path to models.yaml)\n');
  process.exit(2);
}

let yamlText: string;
try {
  yamlText = readFileSync(yamlPath, 'utf8');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gc-classify: cannot read ${yamlPath}: ${msg}\n`);
  process.exit(2);
}

let tokens: Set<string>;
try {
  tokens = collectReferencedTokens(yamlText);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gc-classify: ${msg}\n`);
  process.exit(2);
}

// Wire-format constants — mirrored in bin/gc-models.sh. Keep in sync.
// FIELD_SEP = ASCII Record Separator (0x1e), used as the FIELD separator.
// RECORD_TERM = NUL (0x00), used as the RECORD terminator. NUL cannot
// legally appear inside a POSIX path, so it is the safe outer delimiter.
const FIELD_SEP = '\x1e';
const RECORD_TERM = '\x00';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
});
process.stdin.on('end', () => {
  for (const line of buf.split('\n')) {
    const rel = line.trim();
    if (rel.length === 0) continue;
    const result = classifyCandidate(rel, tokens);
    // Use '-' as the placeholder for an empty reason — keeps the shell's
    // 3-field `read -d ''` loop unconditional. The shell wrapper translates
    // '-' back to empty in its summary output.
    process.stdout.write(
      (result.referenced ? '1' : '0') +
        FIELD_SEP +
        (result.reason ?? '-') +
        FIELD_SEP +
        rel +
        RECORD_TERM,
    );
  }
});
