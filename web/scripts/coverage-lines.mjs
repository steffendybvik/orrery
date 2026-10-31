// `node scripts/coverage-lines.mjs --v8 <dir> --out <file>`: which lines of the source a run's processes reached, from the
// files V8 writes under NODE_V8_COVERAGE, for what Vitest's own count can't see (ORR-745): the server behind the browser
// suite and the channel, launcher and hook that tests spawn. Only code Node ran as it is on disk counts: the dev server's
// bundle, through its source map, and channel/*.mjs. Vitest's workers transform what they load, so their offsets mean nothing
// here. `pnpm test:report --lines <file>` adds these to the coverage it reports.
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, relative, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import v8ToIstanbul from 'v8-to-istanbul'

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BUNDLE = /\/\.nuxt\/dev\/index\.mjs$/
const CHANNEL = /\/channel\/[^/]+\.mjs$/
const OURS = /^(web\/(server|shared|app)\/|channel\/)/

/** The lines of each file of ours that a script ran, from the repo's root, whichever folder the run was in. */
async function linesOf(path, functions, into) {
    const bundle = BUNDLE.test(path)
    const map = `${path}.map`
    if (bundle && !existsSync(map)) throw new Error(`${path} has no source map, so its lines can't be told`)
    const converter = v8ToIstanbul(path, 0, bundle ? {source: readFileSync(path, 'utf8'), sourceMap: {sourcemap: JSON.parse(readFileSync(map, 'utf8'))}} : undefined)
    await converter.load()
    converter.applyCoverage(functions)
    for (const [file, coverage] of Object.entries(converter.toIstanbul())) {
        const from = relative(REPO, resolve(file))
        if (!OURS.test(from)) continue
        const lines = into[from] ??= new Set()
        for (const [id, count] of Object.entries(coverage.s)) if (count) lines.add(coverage.statementMap[id].start.line)
    }
    converter.destroy()
}

/** Each file V8 wrote in `dir`, added up: what any one process reached counts. */
export async function coveredLines(dir) {
    const into = {}
    for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) {
        const {result} = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        for (const {url, functions} of result) {
            if (!url.startsWith('file:')) continue
            const path = fileURLToPath(url)
            if (BUNDLE.test(path) || CHANNEL.test(path) && existsSync(path)) await linesOf(path, functions, into)
        }
    }
    return Object.fromEntries(Object.entries(into).sort().map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]))
}

const arg = name => {
    const at = process.argv.indexOf(`--${name}`)
    return at === -1 ? undefined : process.argv[at + 1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [dir, out] = [arg('v8'), arg('out')]
    if (!dir || !out) throw new Error('Say where: --v8 <dir> --out <file>')
    const lines = await coveredLines(dir)
    writeFileSync(out, JSON.stringify(lines))
    console.log(`${Object.keys(lines).length} files, ${Object.values(lines).reduce((sum, list) => sum + list.length, 0)} lines`)
}
