// The routes each server has, read off their sources, as `METHOD /api/path` with `{param}`s: the Nuxt server's from its
// route files (server/api), the Rust API's from `router()` in api/src/main.rs and each `routes()` in api/src/routes/,
// and the contract's from api/openapi.yaml.
// For the tests that hold the two servers to each other (ORR-1010).
import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** Every route the Nuxt server has, from its files' names (`[id]` as `{id}`, `index` as its folder). */
export function nuxtRoutes(): string[] {
    const root = fileURLToPath(new URL('../server/api', import.meta.url))
    const walk = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
    return walk(root).flatMap(file => {
        const [, route = '', method = ''] = /^(.*?)\.(get|put|post|patch|delete)\.ts$/.exec(relative(root, file)) ?? []
        return method ? [`${method.toUpperCase()} ${`/api/${route}`.replace(/\/index$/, '').replace(/\[(\w+)\]/g, '{$1}')}`] : []
    }).sort()
}

/** Every route the Rust API serves: `router()` in api/src/main.rs and each domain's `routes()` in api/src/routes/
 * (ORR-1048), read as `.route(path, get(…).post(…))`, with `P` as the project's prefix (api/src/routes/mod.rs). */
export function rustRoutes(): string[] {
    const main = read('../../api/src/main.rs')
    const prefix = /const P: &str = "([^"]+)";/.exec(read('../../api/src/routes/mod.rs'))?.[1] ?? ''
    const dir = fileURLToPath(new URL('../../api/src/routes', import.meta.url))
    const sources = [main, ...readdirSync(dir).filter(file => file !== 'mod.rs' && file.endsWith('.rs')).map(file => readFileSync(join(dir, file), 'utf8'))]
    const routes: string[] = []
    for (const source of sources) {
        const body = /\nfn router\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? /\npub\(crate\) fn routes\(\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1]
        if (!body) throw new Error('no router() or routes() in one of api/src/main.rs, api/src/routes/*.rs')
        // One call a piece, whatever rustfmt wrapped.
        for (const call of body.replace(/\s+/g, ' ').split('.route(').slice(1)) {
            const at = /^\s*(?:&format!\("\{P\}([^"]*)"\)|"([^"]+)"|P),(.*)$/.exec(call)
            if (!at) throw new Error(`no path read off .route(${call.trim()}`)
            const path = at[1] !== undefined ? prefix + at[1].replace(/\{\{(\w+)\}\}/g, '{$1}') : at[2] ?? prefix
            const methods = [...at[3]!.matchAll(/(?:^|[\s.:])(get|put|post|patch|delete)\(/g)].map(m => m[1]!.toUpperCase())
            if (!methods.length) throw new Error(`no method read off .route(${call.trim()}`)
            for (const method of methods) routes.push(`${method} ${path}`)
        }
    }
    return routes.sort()
}

/** The contract's operations, read off its lines: a path at two spaces in, its methods at four. One with
 * `x-served: false` at six is written ahead of the Rust API's (the contract comes first): `ahead` has those. */
export function contract(ahead = false): string[] {
    const operations: {operation: string, ahead: boolean}[] = []
    let path = ''
    for (const line of read('../../api/openapi.yaml').split('\n')) {
        const at = /^ {2}(\/api\/\S+):$/.exec(line)
        if (at) path = at[1]!
        else if (/^\S/.test(line)) path = ''
        const method = /^ {4}(get|put|post|patch|delete):/.exec(line)
        if (path && method) operations.push({operation: `${method[1]!.toUpperCase()} ${path}`, ahead: false})
        else if (path && operations.length && /^ {6}x-served: false\s*$/.test(line)) operations.at(-1)!.ahead = true
    }
    return operations.filter(o => o.ahead === ahead).map(o => o.operation).sort()
}

/** The replies the contract gives each operation, its statuses in order (`'200'`, `'404'`…), whether served or ahead. */
export function replies(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    let path = ''
    let operation = ''
    let inResponses = false
    for (const line of read('../../api/openapi.yaml').split('\n')) {
        const at = /^ {2}(\/api\/\S+):$/.exec(line)
        if (at) [path, operation] = [at[1]!, '']
        else if (/^\S/.test(line)) [path, operation] = ['', '']
        const method = /^ {4}(get|put|post|patch|delete):/.exec(line)
        if (path && method) [operation, inResponses] = [`${method[1]!.toUpperCase()} ${path}`, false]
        else if (/^ {4}\S/.test(line)) operation = ''
        if (!operation) continue
        if (/^ {6}responses:/.test(line)) inResponses = true
        else if (/^ {6}\S/.test(line)) inResponses = false
        const status = inResponses && /^ {8}'(\d{3})':/.exec(line)
        if (status) (out[operation] ??= []).push(status[1]!)
    }
    return out
}

/** A route as a path a request would take, its `{param}`s filled in, for the router's `servedByApi`. */
export const pathOf = (route: string) => route.slice(route.indexOf(' ') + 1).replace(/\{\w+\}/g, 'x')
export const methodOf = (route: string) => route.slice(0, route.indexOf(' '))
