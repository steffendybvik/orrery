import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

// The browser suite shares one orrery and runs its groups side by side (playwright.config.ts), so two specs making a
// project of the same name would refuse each other, depending on which ran first (ORR-765).
const E2E = join(__dirname, '..', 'e2e')
const MAKES = /(?:makeProject\(request, \{|'\/projects', \{|\/projects', \{data: \{)\s*name:\s*['"]([^'"]+)['"]/g

describe('the browser suite', () => {
    it('makes each project in one spec only', () => {
        const makers = new Map<string, string[]>()
        for (const file of readdirSync(E2E).filter(name => name.endsWith('.spec.ts'))) {
            for (const [, name] of readFileSync(join(E2E, file), 'utf8').matchAll(MAKES)) {
                const id = name!.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                makers.set(id, [...new Set([...makers.get(id) ?? [], file])])
            }
        }
        expect(makers.size).toBeGreaterThan(20)
        expect([...makers].filter(([, files]) => files.length > 1)).toEqual([])
    })
})
