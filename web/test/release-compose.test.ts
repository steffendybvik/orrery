import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

// The compose file each release carries (release/compose.yml, ORR-448) is the repo's own with the published image in
// place of the build: the same settings reach orrery, so neither drifts from the other.
const read = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8')
const repo = read('docker-compose.yml')
const release = read('release/compose.yml')

/** The NUXT_ settings orrery's service is given, by name. */
const settings = (compose: string) => Object.fromEntries([...compose.matchAll(/^ {6}(NUXT_\w+): (.*)$/gm)].map(m => [m[1], m[2]]))

describe('the release compose file', () => {
    it("is what Quick start downloads, for the version in package.json, so a new release can't leave it old (ORR-119)", () => {
        const {version} = JSON.parse(read('web/package.json')) as {version: string}
        for (const doc of ['README.md', 'docs/running.md']) {
            expect(read(doc)).toContain(`https://github.com/steffendybvik/orrery/releases/download/v${version}/compose.yml`)
        }
        const quickStart = read('README.md').split('## Quick start')[1]!.split('\n## ')[0]!
        expect(quickStart).not.toContain('--build')
    })

    it('says which folder it runs from, or the one ORRERY_REPO_DIR names (ORR-119)', () => {
        expect(settings(release).NUXT_PUBLIC_REPO_DIR).toBe('${ORRERY_REPO_DIR:-${PWD}}')
    })

    it('passes orrery the same settings as the repo\'s', () => {
        expect(Object.keys(settings(release)).sort()).toEqual(Object.keys(settings(repo)).sort())
    })

    it('runs the published image of its version, under a name that holds whatever the folder is called', () => {
        expect(release).toMatch(/^name: orrery$/m)
        expect(release).toMatch(/^ {4}image: ghcr\.io\/steffendybvik\/orrery:__VERSION__$/m)
        expect(release).not.toMatch(/^ {4}build:/m)
    })

    it('backs up to a volume of its own, making no folder beside it, unless ORRERY_BACKUP names one (ORR-469)', () => {
        for (const compose of [release, repo]) {
            expect(settings(compose)).toMatchObject({NUXT_BACKUP_HOST: '${ORRERY_BACKUP:-orrery-backup}', NUXT_BACKUP_CHOSEN: '${ORRERY_BACKUP:+yes}'})
            expect(compose).toContain('- ${ORRERY_BACKUP:-orrery-backup}:/backup')
            expect(compose).toMatch(/^volumes:\n(?: {2}\S+:\n)*? {2}orrery-backup:$/m)
        }
        expect(release).not.toContain('./backups')
    })
})
