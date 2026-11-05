// `node scripts/e2e-durations.mjs <e2e-results.json>`: how long each browser spec took, in seconds, from a run's
// Playwright JSON report (CI's sqlite/Chrome shards, merged, are the test-results-e2e artifact), written to
// e2e/durations.json. The shards are balanced by it (e2e-shards.ts, ORR-920); a spec it doesn't list counts as a middling
// one, so it only wants refreshing when the shards drift apart, never for the suite to run whole.
import {readFileSync, writeFileSync} from 'node:fs'
import {basename} from 'node:path'

const [file] = process.argv.slice(2)
if (!file) throw new Error('Give it a Playwright JSON report: node scripts/e2e-durations.mjs e2e-results.json')
const seconds = {}
const walk = (suite, spec) => {
    spec = suite.file ?? spec
    for (const test of (suite.specs ?? []).flatMap(s => s.tests)) {
        for (const result of test.results) seconds[basename(spec)] = (seconds[basename(spec)] ?? 0) + result.duration / 1000
    }
    for (const inner of suite.suites ?? []) walk(inner, spec)
}
for (const suite of JSON.parse(readFileSync(file, 'utf8')).suites) walk(suite)
const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => [name, Math.round(s)]))
writeFileSync(new URL('../e2e/durations.json', import.meta.url), `${JSON.stringify(sorted, null, 4)}\n`)
