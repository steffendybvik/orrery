// The browser suite's shards (ORR-920, e2e-shards.ts): every spec in one of them, none in two, the same on every machine,
// and the shards close in how long they take, so CI's jobs finish together.
import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import type {Spec} from '../e2e-shards'
import {shardSeconds, shardSetting, shards} from '../e2e-shards'

const E2E = join(__dirname, '..', 'e2e')
const durations = JSON.parse(readFileSync(join(E2E, 'durations.json'), 'utf8')) as Record<string, number>
/** The groups as playwright.config.ts has them, read from it, so this checks what CI runs. */
const config = readFileSync(join(__dirname, '..', 'playwright.config.ts'), 'utf8')
const listed = (name: string) => [...(new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(config)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => `${m[1]}.spec.ts`)
const [sessions, settings, alone] = [listed('SESSIONS'), listed('SETTINGS'), listed('ALONE')]
const SPECS: Spec[] = readdirSync(E2E).filter(f => f.endsWith('.spec.ts') && f !== 'first-run.spec.ts').sort()
    .map(name => ({name, group: sessions.includes(name) ? 'sessions' : settings.includes(name) ? 'settings' : alone.includes(name) ? 'alone' : 'free'}))

describe('the shards', () => {
    it('read E2E_SHARD, and leave the suite whole without one', () => {
        expect(shardSetting('2/3')).toEqual({index: 2, total: 3})
        for (const value of [undefined, '', '1/1', '0/3', '4/3', 'two']) expect(shardSetting(value), String(value)).toBeNull()
    })

    it('put every spec in exactly one shard, however many there are', () => {
        expect(sessions.length && settings.length && alone.length).toBeTruthy()
        for (const total of [2, 3, 4, 6]) {
            const split = shards(SPECS, total, durations)
            expect(split).toHaveLength(total)
            expect(split.flat().map(s => s.name).sort(), `${total} shards`).toEqual(SPECS.map(s => s.name))
        }
    })

    it('come out the same whichever order the files are listed in', () => {
        expect(shards([...SPECS].reverse(), 3, durations)).toEqual(shards(SPECS, 3, durations))
    })

    it('take about as long as each other, and much less than the whole', () => {
        const seconds = (name: string) => durations[name] ?? 30
        const whole = shardSeconds(SPECS, seconds, 4)
        const each = shards(SPECS, 3, durations).map(shard => shardSeconds(shard, seconds, 4))
        expect(Math.max(...each)).toBeLessThan(whole / 2)
        expect(Math.max(...each) - Math.min(...each)).toBeLessThan(Math.max(...each) / 3)
    })

    it('counts a spec it has no time for as a middling one', () => {
        const split = shards([...SPECS, {name: 'brand-new.spec.ts', group: 'free'}], 3, durations)
        expect(split.flat().filter(s => s.name === 'brand-new.spec.ts')).toHaveLength(1)
    })
})
