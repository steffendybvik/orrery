// Counting feature use (ORR-881): a `(feature, day, count)` row a day, all local, for App settings' Usage. Counts gather
// in memory and are sent to the Rust API once a minute (`flushUse`, `PUT /api/usage`), so a use costs a request nothing.
// The API is the one writer of `feature_use` (ORR-1089): it keeps them only while the owner has counting on (`count_use`,
// off by default), and answers the reads and the forgetting. This server reads no setting and no row for it (ORR-1136);
// it gathers nothing while the server doesn't allow counting (`ORRERY_USAGE=off`).
import {FEATURE_NAME} from '#shared/usage'
import type {H3Event} from 'h3'
import type {Feature} from '#shared/usage'
import {ORRERY} from '../store/schema'
import {writeToApi} from './api-router'

const pending = new Map<string, number>()

const day = (at: Date) => at.toISOString().slice(0, 10)

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

/** Sends what's gathered to the API, which keeps it while counting is on. With no API at all (a test), it's dropped. */
export async function flushUse() {
    if (!pending.size) return
    const gathered = [...pending]
    pending.clear()
    if (!usageAllowed()) return
    const counts = gathered.map(([key, count]) => {
        const [feature, on] = key.split('\n') as [string, string]
        return {feature, day: on, count}
    })
    await writeToApi('PUT', '/api/usage', {counts}, ORRERY, {always: true})
}

/** Drops what's gathered and not yet written, as forgetting every count does before the API forgets the rest. */
export function dropGathered() {
    pending.clear()
}
