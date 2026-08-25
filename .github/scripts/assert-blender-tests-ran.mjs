#!/usr/bin/env node
/**
 * Prove the Blender-gated tests actually RAN.
 *
 * A suite that skips everything exits 0, which is the false green the CI
 * `blender` job exists to prevent: before that job, `skipIf(!haveBlender)` meant
 * CI reported green across three Node versions while never executing a line of
 * scripts/blender_normalize.py — the file where every data-destruction defect in
 * this project's history has lived.
 *
 * ⚠ A blanket "nothing may be pending" check is WRONG, and shipped that way
 * once: `it.skipIf(!caseInsensitive)` correctly skips on Linux ext4 and runs on
 * macOS APFS, so a healthy Linux run legitimately reports one pending test. That
 * assertion conflated a correct platform skip with the failure it was written to
 * catch, and failed a job whose Blender tests had all passed.
 *
 * ⚠⚠ The replacement then had TWO false greens of its own, which is why the
 * suite list below is DERIVED FROM THE SOURCE rather than hardcoded:
 *
 *   - A hardcoded list went stale silently. Renaming ONE describe made its tests
 *     invisible to this check, which then reported them as allowed "platform
 *     skips". The length===0 backstop only fired if ALL of them drifted at once —
 *     and this repo edits describe titles constantly.
 *   - "at least one must have passed" was documented, and the variable holding
 *     that count was used only in a console.log. Zero passed exited 0 while
 *     printing "all ran". Computed-then-dropped, in the checker written to catch
 *     computed-then-dropped.
 *
 * Lives under .github/ rather than scripts/ because package.json ships
 * `scripts/*.mjs` — a CI helper has no business in a consumer's node_modules.
 */

import { readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? 'blender-results.json';
const sourcePath = process.argv[3] ?? 'tests/normalize.test.ts';

/**
 * Suite titles declared `describe.skipIf(!haveBlender)`, read from the test file
 * itself. Derived, not copied: a list maintained by hand is a list that goes
 * stale, and going stale here means silently checking nothing.
 */
function blenderSuiteTitles(source) {
  const pattern = /describe\.skipIf\(\s*!haveBlender[^)]*\)\(\s*(['"`])(.*?)\1/gs;
  return [...source.matchAll(pattern)].map((match) => match[2]);
}

const source = readFileSync(sourcePath, 'utf8');
const suites = blenderSuiteTitles(source);

if (suites.length === 0) {
  console.error(
    `Found no describe.skipIf(!haveBlender) suites in ${sourcePath}. Either the ` +
      'gating pattern changed or the file moved — either way this check is no ' +
      'longer looking at anything, which is the false green it exists to prevent.',
  );
  process.exit(1);
}
console.log(`Gated suites found in source (${suites.length}):`);
for (const title of suites) console.log(`  - ${title}`);

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const assertions = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);

const inBlenderSuite = (a) => suites.some((suite) => (a.ancestorTitles ?? []).includes(suite));
const ran = (a) => a.status === 'passed' || a.status === 'failed';

const blenderTests = assertions.filter(inBlenderSuite);
const skippedBlender = blenderTests.filter((a) => !ran(a));
const passedBlender = blenderTests.filter((a) => a.status === 'passed');
const otherSkipped = assertions.filter((a) => !inBlenderSuite(a) && !ran(a));

console.log(
  `Blender-gated: ${passedBlender.length} passed, ${skippedBlender.length} skipped ` +
    `(other suites skipped ${otherSkipped.length}, allowed)`,
);
for (const a of otherSkipped) console.log(`  platform skip: ${a.fullName ?? a.title}`);

/** Every suite named in the source must be represented in the report. */
const unseen = suites.filter(
  (suite) => !assertions.some((a) => (a.ancestorTitles ?? []).includes(suite)),
);
if (unseen.length > 0) {
  console.error('These gated suites appear in the source but not in the report at all:');
  for (const title of unseen) console.error(`  ${title}`);
  console.error('A suite that produced no result was not run, however green the exit code.');
  process.exit(1);
}

if (skippedBlender.length > 0) {
  console.error(
    `${skippedBlender.length} Blender-gated test(s) SKIPPED in the job that exists to run them:`,
  );
  for (const a of skippedBlender) console.error(`  ${a.fullName ?? a.title}`);
  process.exit(1);
}

// ENFORCED, not merely printed. This is the line the previous version documented
// and did not implement.
if (passedBlender.length === 0) {
  console.error('No Blender-gated test PASSED. This job has proved nothing.');
  process.exit(1);
}

console.log('Blender-gated tests all ran.');
