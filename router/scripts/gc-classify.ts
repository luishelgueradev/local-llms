/**
 * Plan 09-01 (OPS-01) — helper invoked by bin/gc-models.sh.
 *
 * stdin   : one relative path per line (relative to HOST_DATA_ROOT).
 * argv[2] : absolute path to router/models.yaml.
 * stdout  : one line per input, TAB-separated:
 *             <referenced 0|1>\t<reason or empty>\t<relPath>
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
    // Use '-' as the placeholder for an empty reason — bash's `read` with
    // IFS=$'\t' collapses consecutive tab whitespace and a blank middle
    // field would shift RELPATH into REASON. The shell wrapper translates
    // '-' back to empty in its summary output.
    process.stdout.write(
      (result.referenced ? '1' : '0') +
        '\t' +
        (result.reason ?? '-') +
        '\t' +
        rel +
        '\n',
    );
  }
});
