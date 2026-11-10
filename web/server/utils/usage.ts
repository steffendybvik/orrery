// Counting feature use (ORR-881): a `(feature, day, count)` row a day, all local, for App settings' Usage. Counts gather
// in memory and are written once a minute (`flushUse`), so a use costs a request nothing. Only while the owner has
// turned counting on (`count_use`, off by default) and the server allows it (`ORRERY_USAGE=off` doesn't): what gathered
// while it was off is dropped at the next write, not kept. A count only: nothing about who, what or where. With the Rust
// API in front, the counts go to it (`PUT /api/usage`), as it's the one writer of `feature_use` then (ORR-1089), and it
// answers the reads and the forgetting; the gathering stays here.
import {FEATURES, FEATURE_NAME} from '#shared/usage'
import type {H3Event} from 'h3'
import type {Feature, FeatureUse} from '#shared/usage'
import {ORRERY} from '../store/schema'
import {writeToApi} from './api-router'

const KEEP_DAYS = 365
const pending = new Map<string, number>()

const day = (at: Date) => at.toISOString().slice(0, 10)
const daysBefore = (at: Date, days: number) => day(new Date(at.getTime() - days * 86_400_000))

/** The server lets nobody count (`ORRERY_USAGE=off`, `NUXT_USAGE` outside Docker). */
export const usageAllowed = () => String(useRuntimeConfig().usage ?? '').trim().toLowerCase() !== 'off'

/** One use of `feature`, today. A name that isn't one is ignored. */
export function countUse(feature: string, at = new Date()) {
    if (!FEATURE_NAME.test(feature)) return
    const key = `${feature}\n${day(at)}`
    pending.set(key, (pending.get(key) ?? 0) + 1)
}

/** One use of `feature` by the owner themself, at a route: their page or their own sessions, never anyone else's. */
export function countOwnUse(event: H3Event, feature: Feature) {
    const who = event.context?.who as {owner: boolean} | undefined
    if (!who || who.owner) countUse(feature)
}

/** Writes what's gathered, while counting is on, and drops rows over a year old. */
export async function flushUse(now = new Date()) {
    if (!pending.size) return
    const gathered = [...pending]
    pending.clear()
    if (!usageAllowed() || !(await useStore().settings()).count_use) return
    const counts = gathered.map(([key, count]) => {
        const [feature, on] = key.split('\n') as [string, string]
        return {feature, day: on, count}
    })
    if (await writeToApi('PUT', '/api/usage', {counts}, ORRERY, {always: true})) return
    const db = useDatabase()
    for (const [key, count] of gathered) {
        const [feature, on] = key.split('\n') as [string, string]
        await db.run('INSERT INTO feature_use (feature, day, count) VALUES (?, ?, ?) ON CONFLICT (feature, day) DO UPDATE SET count = feature_use.count + excluded.count',
            feature, on, count)
    }
    await db.run('DELETE FROM feature_use WHERE day < ?', daysBefore(now, KEEP_DAYS))
}

/** Each feature counted or listed, its last use and its uses over 30 and 90 days, coldest first. */
export async function featureUse(now = new Date()): Promise<FeatureUse[]> {
    const rows = await useDatabase().all<{feature: string, last: string, days30: number, days90: number}>(
        `SELECT feature, MAX(day) AS last, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS days30, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS days90
         FROM feature_use GROUP BY feature`, daysBefore(now, 30), daysBefore(now, 90))
    const byName = new Map(rows.map(r => [r.feature, r]))
    const names = new Set([...Object.keys(FEATURES), ...byName.keys()])
    const label = (feature: string) => FEATURES[feature as keyof typeof FEATURES] ?? feature.replace(/^(page|tool|dialog):/, '')
    return [...names].map(feature => {
        const row = byName.get(feature)
        return {feature, label: label(feature), last: row?.last ?? null, days30: Number(row?.days30 ?? 0), days90: Number(row?.days90 ?? 0)}
    }).sort((a, b) => a.days90 - b.days90 || (a.last ?? '').localeCompare(b.last ?? '') || a.label.localeCompare(b.label))
}

/** Drops what's gathered and not yet written, as forgetting every count does before the API forgets the rest. */
export function dropGathered() {
    pending.clear()
}

/** Forgets every count: turning counting off and choosing to delete them. */
export async function forgetUse() {
    pending.clear()
    await useDatabase().run('DELETE FROM feature_use')
}
