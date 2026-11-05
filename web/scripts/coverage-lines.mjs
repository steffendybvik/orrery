// `node scripts/coverage-lines.mjs --v8 <dir> --out <file>`: which lines of the source a run's processes reached, from the
// files V8 writes under NODE_V8_COVERAGE, for what Vitest's own count can't see (ORR-745): the server behind the browser
// suite and the channel, launcher and hook that tests spawn. Only code Node ran as it is on disk counts: the dev server's
// bundle, through its source map, and channel/*.mjs. Vitest's workers transform what they load, so their offsets mean nothing
// here. With `--pages <dir>`, it adds what the page's own code ran in Chrome too, as e2e/test.ts wrote it (ORR-784).
// `pnpm test:report --lines <file>` adds these to the coverage it reports.
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, relative, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import v8ToIstanbul from 'v8-to-istanbul'

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BUNDLE = /\/\.nuxt\/dev\/index\.mjs$/
const CHANNEL = /\/channel\/[^/]+\.mjs$/
const OURS = /^(web\/(server|shared|app)\/|channel\/)/

/** The lines of each file of ours that a script ran, from the repo's root, whichever folder the run was in. */
async function linesOf(path, functions, into, sources) {
    const bundle = BUNDLE.test(path)
    const map = `${path}.map`
    if (bundle && !existsSync(map)) throw new Error(`${path} has no source map, so its lines can't be told`)
    const converter = v8ToIstanbul(path, 0, sources ?? (bundle ? {source: readFileSync(path, 'utf8'), sourceMap: {sourcemap: JSON.parse(readFileSync(map, 'utf8'))}} : undefined))
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
    return sorted(into)
}

const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/

/** Where the dev server read a module from: `/_nuxt/` is the page's folder, `/_nuxt/@fs/` the whole disk. */
const servedFrom = path => {
    const rest = decodeURIComponent(path.replace(/^\/_nuxt\//, ''))
    return rest.startsWith('@fs/') ? rest.slice(3) : join(REPO, 'web', 'app', rest)
}

/** The lines of our source that the page's scripts reached in the browser suite (e2e/test.ts, ORR-784): each script as the
 * dev server served it, with a mark on each character that ran, through the source map Vite puts at its end. */
export async function pageLines(reached) {
    const into = {}
    for (const {url, source, ran} of reached.values()) {
        const map = INLINE_MAP.exec(source)
        if (!map) continue
        const sourcemap = JSON.parse(Buffer.from(map[1], 'base64').toString('utf8'))
        // As V8 would say it: the whole script ran, but for each stretch nothing did.
        const ranges = [{startOffset: 0, endOffset: source.length, count: 1}]
        for (let at = 0; at < ran.length;) {
            if (ran[at]) { at++; continue }
            const from = at
            while (at < ran.length && !ran[at]) at++
            ranges.push({startOffset: from, endOffset: at, count: 0})
        }
        await linesOf(servedFrom(new URL(url).pathname), [{functionName: '', isBlockCoverage: true, ranges}], into, {source, sourceMap: {sourcemap}})
    }
    return sorted(into)
}

const sorted = into => Object.fromEntries(Object.entries(into).sort().map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]))

/** The lines each of the browser suite's workers wrote (e2e/test.ts), added up. */
export function pagesLines(dir) {
    const into = {}
    for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) {
        for (const [file, lines] of Object.entries(JSON.parse(readFileSync(join(dir, name), 'utf8')))) {
            const all = into[file] ??= new Set()
            for (const line of lines) all.add(line)
        }
    }
    return sorted(into)
}

const arg = name => {
    const at = process.argv.indexOf(`--${name}`)
    return at === -1 ? undefined : process.argv[at + 1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [dir, pages, out] = [arg('v8'), arg('pages'), arg('out')]
    if (!dir && !pages || !out) throw new Error('Say where: --v8 <dir> and/or --pages <dir>, and --out <file>')
    const lines = {}
    for (const each of [dir && await coveredLines(dir), pages && existsSync(pages) && pagesLines(pages)].filter(Boolean)) {
        for (const [file, reached] of Object.entries(each)) lines[file] = [...new Set([...lines[file] ?? [], ...reached])].sort((a, b) => a - b)
    }
    writeFileSync(out, JSON.stringify(lines))
    console.log(`${Object.keys(lines).length} files, ${Object.values(lines).reduce((sum, list) => sum + list.length, 0)} lines`)
}
