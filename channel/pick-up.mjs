// Pick-up (ORR-599): a session opened in a repo whose .mcp.json registers orrery's channel puts the repo's projects on
// the launcher's list, as `--install` there would, so orrery can start sessions there too. The channel runs this as it
// connects; it's here, with what it reads passed in, so a test can say what goes on the list and what the session is
// told (ORR-631).
import {pickUp} from './launcher-service.mjs'
import {authHeaders} from './credentials.mjs'
import {channelsIn, projectsIn} from './repo-channels.mjs'

/** The projects of the repo at `dir` put on the launcher's list (`file`, the user's by default), none when nothing
 * was. Not in a session orrery started (`ORRERY_STARTED`: it's served already) or a repo whose .mcp.json doesn't
 * register the channel, and only projects their orrery has: one it answers 404 for, can't be reached at, or won't say
 * without a credential (401, 403, 503) is left off. Only the channel, running in the folder on this machine, writes the list: orrery never names a folder. */
export async function pickUpRepo(dir, {env = process.env, fetch = globalThis.fetch, file, now} = {}) {
    if (env.ORRERY_STARTED || !channelsIn(dir).length) return []
    const known = []
    for (const entry of projectsIn(dir, {url: env.ORRERY_URL})) {
        const status = await fetch(`${entry.url}/api/projects/${encodeURIComponent(entry.project)}/launches`, {headers: authHeaders(entry.url, {env})}).then(r => r.status, () => 0)
        if (status && ![401, 403, 404, 503].includes(status)) known.push(entry)
    }
    return pickUp(known, dir, {file, now})
}

/** What the session is told about the projects pick-up `added`, once, with the line that takes the repo off the list
 * again (`launcher`, the launcher's path); null when none were. */
export function pickedUpMessage(added, launcher) {
    if (!added.length) return null
    return `orrery's launcher now serves this repo (${added.map(entry => entry.project).join(', ')}), so orrery can start sessions in it. To take it off, run this here: node ${launcher} --uninstall`
}
