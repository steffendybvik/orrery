import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

// One client for the API (ORR-666): nothing in the page names `/api/` or calls `$fetch` itself.
const APP = join(__dirname, '..', 'app')
const sources = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.(ts|vue)$/.test(entry.name) ? [path] : []
})
/** Each line of the page's code that does what `pattern` finds, without comments, outside the files allowed it. */
const found = (pattern: RegExp, allowed: string[]) => sources(APP)
    .filter(path => !allowed.includes(relative(APP, path)))
    .flatMap(path => readFileSync(path, 'utf8').split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line) && pattern.test(line))
        .map(line => `${relative(APP, path)}: ${line.trim()}`))

describe('the API client', () => {
    it('is the only place that names an API address', () => {
        expect(found(/["'`]\/api\b/, ['utils/api.ts'])).toEqual([])
    })

    it('is the only place that calls $fetch, but for the plugin that wraps it', () => {
        expect(found(/\$fetch\b/, ['utils/api.ts', 'plugins/unseen.client.ts'])).toEqual([])
    })
})
