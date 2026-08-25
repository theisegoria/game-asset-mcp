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
 * So this checks the thing it actually cares about, by name: no test inside a
 * Blender-gated suite may be pending, and at least one must have passed.
 *
 * Lives under .github/ rather than scripts/ because package.json ships
 * `scripts/*.mjs` — a CI helper has no business in a consumer's node_modules.
 */

import { readFileSync } from 'node:fs';

/** Suite titles declared `describe.skipIf(!haveBlender)`. */
const BLENDER_SUITES = [
  'normalizing a real UV-less mesh',
  'the weld threshold respects world scale',
  'splitting scale between node and vertices changes nothing',
  'merging nothing still repairs degenerate faces',
  'mergeDistance 0 repairs degenerate faces at any scale',
];

const report = JSON.parse(readFileSync(process.argv[2] ?? 'blender-results.json', 'utf8'));
const assertions = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);

const inBlenderSuite = (a) =>
  BLENDER_SUITES.some((suite) => (a.ancestorTitles ?? []).includes(suite));

const blenderTests = assertions.filter(inBlenderSuite);
const skippedBlender = blenderTests.filter((a) => a.status !== 'passed' && a.status !== 'failed');
const passedBlender = blenderTests.filter((a) => a.status === 'passed');
const otherSkipped = assertions.filter(
  (a) => !inBlenderSuite(a) && a.status !== 'passed' && a.status !== 'failed',
);

console.log(
  `Blender-gated: ${passedBlender.length} passed, ${skippedBlender.length} skipped ` +
    `(other suites skipped ${otherSkipped.length}, allowed)`,
);
for (const a of otherSkipped) console.log(`  platform skip: ${a.fullName ?? a.title}`);

if (blenderTests.length === 0) {
  console.error(
    'No Blender-gated test was found AT ALL. Either the suite titles in this ' +
      'script have drifted from the test file, or nothing ran — both mean this ' +
      'job proved nothing.',
  );
  process.exit(1);
}
if (skippedBlender.length > 0) {
  console.error(`${skippedBlender.length} Blender-gated test(s) SKIPPED in the job that exists to run them:`);
  for (const a of skippedBlender) console.error(`  ${a.fullName ?? a.title}`);
  process.exit(1);
}
console.log('Blender-gated tests all ran.');
