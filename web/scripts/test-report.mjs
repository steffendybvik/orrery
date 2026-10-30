// `pnpm test:report`: writes the Test speed and coverage artifact (ORR-678) from a run's results, Vitest's and Playwright's
// JSON reporters and the coverage summary, to the orrery's docs. A run belongs to the version in package.json, and
// replaces that version's numbers until it ships. Every version's numbers live in the page itself, carried forward from
// the doc each time, so the page needs nothing outside itself.
//
//   pnpm test:report --vitest vitest.json --e2e e2e.json --coverage coverage/coverage-summary.json --source ci
//
// `--source` says where the run was, as times from a laptop and from CI can't be compared; `--out page.html` writes the
// file instead of the doc. ORRERY_URL says which orrery (http://localhost:9000), ORRERY_KEY its key if it asks for one.
import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'
import {relative, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const TOP = 15
const DOC = 'test-speed-and-coverage'
const TITLE = 'Test speed and coverage'
/** The same areas as CI's coverage summary (.github/workflows/ci.yml). */
const AREAS = [['server/api', /\/web\/server\/api\//], ['server/middleware', /\/web\/server\/middleware\//], ['server/utils', /\/web\/server\/utils\//],
    ['server/store', /\/web\/server\/store\//], ['shared', /\/web\/shared\//], ['app', /\/web\/app\//], ['channel', /\/channel\/[^/]+\.mjs$/]]

const seconds = ms => Math.round(ms / 10) / 100
const slowestFirst = list => [...list].sort((a, b) => b.seconds - a.seconds).slice(0, TOP)
/** The path from the repo's root, wherever the run was. */
const short = path => path.replace(/^.*?\/(web|channel)\//, '$1/')
const pct = (covered, total) => total ? Math.round(1000 * covered / total) / 10 : null

/** Vitest's JSON reporter: the wall clock of the run, and the slowest files and tests. */
export function unitNumbers(json) {
    const files = json.testResults.map(file => ({name: short(file.name), seconds: seconds(file.endTime - file.startTime), tests: file.assertionResults.length}))
    const tests = json.testResults.flatMap(file => file.assertionResults.map(test => ({name: test.fullName, file: short(file.name), seconds: seconds(test.duration ?? 0)})))
    return {
        seconds: seconds(Math.max(...json.testResults.map(file => file.endTime)) - json.startTime),
        tests: json.numTotalTests, failed: json.numFailedTests, skipped: json.numPendingTests + (json.numTodoTests ?? 0),
        files: slowestFirst(files), slowest: slowestFirst(tests),
    }
}

/** Playwright's JSON reporter: the same, by spec. A retried test counts each try, as the run had to wait for them. */
export function e2eNumbers(json) {
    const specs = []
    const walk = suite => {
        specs.push(...(suite.specs ?? []).map(spec => ({spec, file: spec.file ?? suite.file})))
        for (const inner of suite.suites ?? []) walk(inner)
    }
    for (const suite of json.suites) walk(suite)
    const tests = specs.map(({spec, file}) => ({
        name: spec.title, file: `e2e/${file}`, seconds: seconds(spec.tests.flatMap(test => test.results).reduce((sum, result) => sum + result.duration, 0)),
    }))
    const byFile = new Map()
    for (const test of tests) {
        const file = byFile.get(test.file) ?? {name: test.file, seconds: 0, tests: 0}
        byFile.set(test.file, {...file, seconds: seconds((file.seconds + test.seconds) * 1000), tests: file.tests + 1})
    }
    return {
        seconds: seconds(json.stats.duration),
        tests: tests.length, failed: json.stats.unexpected + (json.stats.flaky ?? 0), skipped: json.stats.skipped,
        files: slowestFirst([...byFile.values()]), slowest: slowestFirst(tests),
    }
}

/** The coverage summary: the totals, each area, and the files least covered, the largest first among equals. */
export function coverageNumbers(summary) {
    const files = Object.entries(summary).filter(([file]) => file !== 'total').map(([file, numbers]) => ({file, ...numbers}))
    const sum = (list, key) => list.reduce(([covered, total], file) => [covered + file[key].covered, total + file[key].total], [0, 0])
    return {
        lines: summary.total.lines.pct, branches: summary.total.branches.pct, functions: summary.total.functions.pct,
        areas: AREAS.map(([area, path]) => {
            const ours = files.filter(file => path.test(file.file))
            return {area, files: ours.length, untested: ours.filter(file => file.lines.total && !file.lines.covered).length, lines: pct(...sum(ours, 'lines')), branches: pct(...sum(ours, 'branches'))}
        }),
        least: files.filter(file => file.lines.total)
            .sort((a, b) => a.lines.pct - b.lines.pct || b.lines.total - a.lines.total).slice(0, TOP)
            .map(file => ({file: short(file.file), lines: file.lines.pct, total: file.lines.total})),
    }
}

const RUNS = /<script type="application\/json" id="runs">([\s\S]*?)<\/script>/

/** The versions' numbers a page holds, none in a doc that's new. One whose numbers can't be read stops the run, as writing
 * over it would lose every version: put it right, or bring back an earlier copy from its history. */
export function runsIn(html) {
    const block = RUNS.exec(html ?? '')
    if (!block) return []
    let runs
    try {
        runs = JSON.parse(block[1])
    } catch {
        runs = null
    }
    if (!Array.isArray(runs)) throw new Error("The doc's numbers can't be read, so nothing was written: fix them, or restore an earlier copy from its History")
    return runs
}

/** Adds a run: a version's second run replaces its first, and otherwise it goes last. */
export const withRun = (runs, run) => runs.some(r => r.version === run.version) ? runs.map(r => r.version === run.version ? run : r) : [...runs, run]

/** The page: the numbers as JSON that can't end its own script tag, and what draws them. */
export const page = runs => PAGE.replace('__RUNS__', () => JSON.stringify(runs).replace(/</g, '\\u003c'))

const PAGE = String.raw`<style>
  :root { --series: #2a78d6; }
  .dark { --series: #3987e5; }
  .bar { height: 8px; border-radius: 0 4px 4px 0; background: var(--series); }
  .num { font-variant-numeric: tabular-nums; }
  #tip { position: fixed; pointer-events: none; display: none; }
  svg circle.hit { fill: transparent; cursor: default; outline: none; }
</style>
<script type="application/json" id="runs">__RUNS__</script>
<main class="bg-canvas text-fg min-h-screen p-4 sm:p-6 text-sm flex flex-col gap-6 max-w-5xl mx-auto">
  <header class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold">Test speed and coverage</h1>
      <p id="about" class="text-muted"></p>
    </div>
    <label class="flex items-center gap-2 text-muted">Version
      <select id="version" class="bg-panel text-fg rounded-md ring-1 ring-line px-2 py-1"></select>
    </label>
  </header>
  <section id="tiles" class="grid gap-3 sm:grid-cols-3"></section>
  <section id="trends" class="grid gap-3 sm:grid-cols-3" aria-label="Each total across versions"></section>
  <details class="bg-panel rounded-lg ring-1 ring-line p-3"><summary class="cursor-pointer text-muted">Every version as a table</summary><div id="table" class="overflow-x-auto mt-2"></div></details>
  <section id="detail" class="grid gap-3 md:grid-cols-2"></section>
</main>
<div id="tip" class="bg-raised text-fg rounded-md ring-1 ring-line px-2 py-1 text-xs shadow-lg"></div>
<script>
const el = id => document.getElementById(id)
let runs = []
try {
  runs = JSON.parse(el('runs').textContent)
} catch {
  el('about').textContent = "This copy's numbers can't be read. An earlier one is in the doc's History."
}
const esc = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')
const time = s => s >= 60 ? Math.floor(s / 60) + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's' : s >= 10 ? Math.round(s) + 's' : s.toFixed(1) + 's'
const percent = n => n === null || n === undefined ? '–' : n.toFixed(1) + '%'
const card = (title, body, hint) => '<div class="bg-panel rounded-lg ring-1 ring-line p-3 flex flex-col gap-2 min-w-0"><h2 class="font-medium">' + title + (hint ? ' <span class="font-normal text-muted">' + hint + '</span>' : '') + '</h2>' + body + '</div>'

const MEASURES = [
  {title: 'Unit tests', of: r => r.unit.seconds, say: time, more: 'slower', less: 'faster', count: r => r.unit},
  {title: 'E2E tests', of: r => r.e2e.seconds, say: time, more: 'slower', less: 'faster', count: r => r.e2e},
  {title: 'Coverage, lines', of: r => r.coverage.lines, say: percent, by: n => n.toFixed(1) + ' points', more: 'up', less: 'down', fixed: 100},
]

function tile(measure, run, before) {
  const value = measure.of(run)
  let change = 'The first version here'
  if (before && before.source !== run.source) change = 'Not compared with ' + esc(before.version) + ': one is local, one on CI'
  else if (before) {
    const by = value - measure.of(before)
    change = Math.abs(by) < 0.05 ? 'Level with ' + esc(before.version)
      : (by > 0 ? '▲ ' : '▼ ') + (measure.by ?? measure.say)(Math.abs(by)) + ' ' + (by > 0 ? measure.more : measure.less) + ' than ' + esc(before.version)
  }
  const count = measure.count && measure.count(run)
  const under = count ? count.tests + ' tests' + (count.failed ? ', ' + count.failed + ' failed' : '') + (count.skipped ? ', ' + count.skipped + ' skipped' : '')
    : 'Branches ' + percent(run.coverage.branches) + ', functions ' + percent(run.coverage.functions)
  return '<div class="bg-panel rounded-lg ring-1 ring-line p-3"><div class="text-muted">' + measure.title + '</div><div class="text-2xl font-semibold num">' + measure.say(value) + '</div><div class="text-muted text-xs">' + under + '</div><div class="text-xs mt-1">' + change + '</div></div>'
}

function trend(measure, picked) {
  const W = 320, H = 110, L = 8, R = 8, T = 10, B = 22
  const top = measure.fixed ?? Math.max(...runs.map(measure.of), 1) * 1.1
  const x = i => runs.length === 1 ? W / 2 : L + i * (W - L - R) / (runs.length - 1)
  const y = v => T + (1 - v / top) * (H - T - B)
  const line = runs.map((r, i) => x(i).toFixed(1) + ',' + y(measure.of(r)).toFixed(1)).join(' ')
  const marks = runs.map((r, i) => {
    const local = r.source !== 'ci'
    return '<circle cx="' + x(i) + '" cy="' + y(measure.of(r)) + '" r="' + (r.version === picked ? 5 : 4) + '" stroke="var(--series)" stroke-width="2" fill="' + (local ? 'var(--panel)' : 'var(--series)') + '"/>'
      + '<circle class="hit" tabindex="0" role="img" aria-label="' + esc(r.version + ': ' + measure.say(measure.of(r))) + '" data-tip="' + esc(r.version + ' · ' + measure.say(measure.of(r)) + ' · ' + (local ? 'local' : 'CI')) + '" cx="' + x(i) + '" cy="' + y(measure.of(r)) + '" r="14"/>'
  }).join('')
  const names = (runs.length > 6 ? [0, runs.length - 1] : runs.map((_, i) => i)).map(i =>
    '<text x="' + x(i) + '" y="' + (H - 6) + '" font-size="11" fill="var(--muted)" text-anchor="' + (runs.length > 1 && i === 0 ? 'start' : runs.length > 1 && i === runs.length - 1 ? 'end' : 'middle') + '">' + esc(runs[i].version.replace(/^1\.0\.0-/, '')) + '</text>').join('')
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="w-full" role="group" aria-label="' + esc(measure.title) + ' across versions">'
    + '<line x1="0" x2="' + W + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="var(--line)"/>'
    + (runs.length > 1 ? '<polyline points="' + line + '" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round"/>' : '') + marks + names + '</svg>'
  return card(measure.title, svg, 'by version')
}

const bars = (rows, label, value, say, fixed, under) => {
  const top = fixed ?? Math.max(...rows.map(value), 0.001)
  return '<ul class="flex flex-col gap-1.5">' + rows.map(row => '<li class="flex flex-col gap-0.5" data-tip="' + esc(label(row) + ' · ' + say(row)) + '"><div class="flex justify-between gap-3"><span class="truncate min-w-0" title="' + esc(label(row)) + '">' + esc(label(row)) + '</span><span class="num text-muted shrink-0">' + esc(say(row)) + '</span></div><div class="bar" style="width:' + (value(row) ? Math.max(1, 100 * value(row) / top) : 0) + '%"></div>' + (under ? '<div class="text-muted text-xs">' + esc(under(row)) + '</div>' : '') + '</li>').join('') + '</ul>'
}
const list = (rows, say) => '<ol class="flex flex-col gap-1">' + rows.map(row => '<li class="flex justify-between gap-3"><span class="min-w-0 truncate" title="' + esc(row.file + ': ' + row.name) + '">' + esc(row.name) + '</span><span class="num text-muted shrink-0">' + esc(say(row)) + '</span></li>').join('') + '</ol>'
const noTests = n => n + (n === 1 ? ' test' : ' tests')

function draw(version) {
  const at = runs.findIndex(r => r.version === version)
  const run = runs[at], before = runs[at - 1]
  el('about').textContent = run.date + ' · ' + run.commit + ' · ' + (run.source === 'ci' ? 'on CI' : 'run locally, so its times only compare with other local runs')
  el('tiles').innerHTML = MEASURES.map(m => tile(m, run, before)).join('')
  el('trends').innerHTML = MEASURES.map(m => trend(m, version)).join('')
  el('table').innerHTML = '<table class="w-full text-left num"><thead class="text-muted"><tr><th class="pr-4 font-medium">Version</th><th class="pr-4 font-medium">Date</th><th class="pr-4 font-medium">Where</th><th class="pr-4 font-medium">Unit</th><th class="pr-4 font-medium">E2E</th><th class="pr-4 font-medium">Lines</th><th class="font-medium">Branches</th></tr></thead><tbody>'
    + runs.map(r => '<tr><td class="pr-4">' + esc(r.version) + '</td><td class="pr-4">' + esc(r.date) + '</td><td class="pr-4">' + (r.source === 'ci' ? 'CI' : 'local') + '</td><td class="pr-4">' + time(r.unit.seconds) + '</td><td class="pr-4">' + time(r.e2e.seconds) + '</td><td class="pr-4">' + percent(r.coverage.lines) + '</td><td>' + percent(r.coverage.branches) + '</td></tr>').join('') + '</tbody></table>'
  const file = row => row.name
  const taken = row => time(row.seconds) + ' · ' + noTests(row.tests)
  el('detail').innerHTML = [
    card('Slowest unit files', bars(run.unit.files, file, row => row.seconds, taken)),
    card('Slowest E2E specs', bars(run.e2e.files, file, row => row.seconds, taken)),
    card('Slowest unit tests', list(run.unit.slowest, row => time(row.seconds))),
    card('Slowest E2E tests', list(run.e2e.slowest, row => time(row.seconds))),
    card('Coverage by area', bars(run.coverage.areas, row => row.area, row => row.lines ?? 0, row => percent(row.lines) + ' lines · ' + percent(row.branches) + ' branches', 100, row => row.files + ' files' + (row.untested ? ', ' + row.untested + ' run by no test' : ''))),
    card('Least covered files', bars(run.coverage.least, row => row.file, row => row.lines, row => percent(row.lines) + ' of ' + row.total + ' lines', 100)),
  ].join('')
}

el('version').innerHTML = runs.map(r => '<option>' + esc(r.version) + '</option>').reverse().join('')
el('version').addEventListener('change', event => draw(event.target.value))
if (runs.length) draw(runs[runs.length - 1].version)

const tip = el('tip')
const show = (event, target) => {
  tip.textContent = target.dataset.tip
  tip.style.display = 'block'
  const box = target.getBoundingClientRect()
  const x = event.clientX || box.left, y = event.clientY || box.top
  tip.style.left = Math.min(x + 12, innerWidth - tip.offsetWidth - 8) + 'px'
  tip.style.top = Math.max(y - tip.offsetHeight - 8, 8) + 'px'
}
for (const type of ['mousemove', 'focusin']) document.addEventListener(type, event => {
  const target = event.target.closest && event.target.closest('[data-tip]')
  if (target) show(event, target)
  else tip.style.display = 'none'
})
document.addEventListener('focusout', () => { tip.style.display = 'none' })
</script>
`

const arg = name => {
    const at = process.argv.indexOf(`--${name}`)
    return at === -1 ? undefined : process.argv[at + 1]
}

async function main() {
    const read = name => {
        const path = arg(name)
        if (!path) throw new Error(`Say where the results are: --${name} <file>`)
        return JSON.parse(readFileSync(path, 'utf8'))
    }
    const source = arg('source')
    if (source !== 'ci' && source !== 'local') throw new Error('Say where the run was: --source ci or --source local')
    const run = {
        version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
        date: new Date().toISOString().slice(0, 10),
        commit: (process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'})).trim().slice(0, 8),
        source, unit: unitNumbers(read('vitest')), e2e: e2eNumbers(read('e2e')), coverage: coverageNumbers(read('coverage')),
    }
    const base = process.env.ORRERY_URL ?? 'http://localhost:9000'
    const url = `${base}/api/projects/orrery/docs`
    const headers = {'Content-Type': 'application/json', 'Orrery-Actor': 'claude', ...process.env.ORRERY_KEY ? {Authorization: `Bearer ${process.env.ORRERY_KEY}`} : {}}
    const out = arg('out')
    const was = out ? null : await fetch(`${url}/${DOC}`, {headers})
    if (was && !was.ok && was.status !== 404) throw new Error(`${base} said ${was.status} reading the doc`)
    const had = was?.ok ? await was.json() : null
    const html = page(withRun(runsIn(had?.body), run))
    if (out) {
        writeFileSync(out, html)
        return console.log(`Wrote ${relative(process.cwd(), resolve(out))}`)
    }
    const saved = await fetch(had ? `${url}/${DOC}` : url, {
        method: had ? 'PATCH' : 'POST', headers,
        body: JSON.stringify(had ? {body: html} : {id: DOC, title: TITLE, kind: 'artifact', section: 'Working on Orrery', body: html}),
    })
    if (!saved.ok) throw new Error(`${base} said ${saved.status}: ${await saved.text()}`)
    console.log(`${run.version}: unit ${run.unit.seconds}s, e2e ${run.e2e.seconds}s, lines ${run.coverage.lines}% (${source}), at ${base}/p/orrery/docs/${DOC}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main().catch(error => {
        console.error(error.message)
        process.exit(1)
    })
}
