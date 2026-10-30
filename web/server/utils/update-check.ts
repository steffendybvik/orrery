// Whether a newer orrery is out (ORR-608): its releases on GitHub, read anonymously at start and every 12 hours, against
// the version running. orrery's own repo is public, so it's named here, as the sidebar's GitHub links are. A release
// that's still a pre-release only counts for an orrery running one: 1.0.0 doesn't offer 1.1.0-rc.1. Turned off with
// ORRERY_UPDATE_CHECK=false (NUXT_UPDATE_CHECK). A check that fails stays quiet: a line in the event log, no notice.
import type {EventEntry} from './event-log'

export const RELEASES = 'https://api.github.com/repos/steffendybvik/orrery/releases?per_page=20'

/** How often it asks again. */
export const UPDATE_EVERY = 12 * 60 * 60 * 1000

export interface NewerVersion {
    version: string
    /** The release's page on GitHub, with its notes. */
    url: string
}

interface Release { tag_name: string, html_url: string, draft?: boolean, prerelease?: boolean }

/** A version's parts: `1.0.0-rc.13` → [1, 0, 0] and ['rc', 13]; null when it isn't one. */
function parse(version: string): {core: [number, number, number], pre: (string | number)[]} | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
    if (!match) return null
    const pre = match[4] ? match[4].split('.').map(p => /^\d+$/.test(p) ? Number(p) : p) : []
    return {core: [Number(match[1]), Number(match[2]), Number(match[3])], pre}
}

/** Semver order: below zero when `a` comes before `b`. A pre-release comes before its release (rc.13 < rc.14 <
 * 1.0.0), and numbers in it count as numbers. Null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
    const [x, y] = [parse(a), parse(b)]
    if (!x || !y) return null
    for (const i of [0, 1, 2] as const) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
    if (!x.pre.length || !y.pre.length) return Number(!x.pre.length) - Number(!y.pre.length)
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const [p, q] = [x.pre[i], y.pre[i]]
        if (p === undefined) return -1
        if (q === undefined) return 1
        if (p === q) continue
        if (typeof p === 'number' && typeof q === 'number') return p - q
        if (typeof p === 'number') return -1
        if (typeof q === 'number') return 1
        return p < q ? -1 : 1
    }
    return 0
}

/** The newest release past `current`, or null: drafts never, pre-releases only when `current` is one. */
export function newerThan(current: string, releases: Release[]): NewerVersion | null {
    const onPre = /-/.test(current.replace(/\+.*$/, ''))
    let best: NewerVersion | null = null
    for (const release of releases) {
        if (release.draft || (release.prerelease && !onPre)) continue
        const version = release.tag_name.replace(/^v/, '')
        if ((compareVersions(version, current) ?? 0) <= 0) continue
        if (!best || (compareVersions(version, best.version) ?? 0) > 0) best = {version, url: release.html_url}
    }
    return best
}

/** The last answer, kept between checks. */
export class UpdateCheck {
    newer: NewerVersion | null = null

    constructor(
        private readonly current: string,
        private readonly get: (url: string) => Promise<Response>,
        private readonly note: (entry: EventEntry) => void,
    ) {}

    /** Asks GitHub again; on a failure, keeps what it knew and notes why. */
    async check(): Promise<NewerVersion | null> {
        try {
            const response = await this.get(RELEASES)
            if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
            this.newer = newerThan(this.current, await response.json() as Release[])
        } catch (error) {
            this.note({level: 'warn', kind: 'update.failed', message: `Couldn't check for a newer orrery: ${error instanceof Error ? error.message : String(error)}`})
        }
        return this.newer
    }
}
