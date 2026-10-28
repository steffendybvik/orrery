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
    it('passes orrery the same settings as the repo\'s', () => {
        expect(Object.keys(settings(release)).sort()).toEqual(Object.keys(settings(repo)).sort())
    })

    it('runs the published image of its version, under a name that holds whatever the folder is called', () => {
        expect(release).toMatch(/^name: orrery$/m)
        expect(release).toMatch(/^ {4}image: ghcr\.io\/steffendybvik\/orrery:__VERSION__$/m)
        expect(release).not.toMatch(/^ {4}build:/m)
    })

    it('keeps the backups beside it by default, and says so when they are elsewhere', () => {
        expect(settings(release)).toMatchObject({NUXT_BACKUP_HOST: '${ORRERY_BACKUP:-./backups}', NUXT_BACKUP_CHOSEN: '${ORRERY_BACKUP:+yes}'})
        expect(release).toContain('- ${ORRERY_BACKUP:-./backups}:/backup')
        expect(settings(repo)).toMatchObject({NUXT_BACKUP_CHOSEN: '${ORRERY_BACKUP:+yes}'})
    })
})
