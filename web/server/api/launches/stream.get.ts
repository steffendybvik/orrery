import type {LaunchEvent, LauncherServes} from '../../utils/launches'
import {launcherMinimum} from '#shared/version'

// `GET /api/launches/stream?serve=[{project, dir?, home?, every?, picked?, connected?}, …]&version=` → one launcher's
// server-sent events for every project it serves on this orrery (ORR-1076), in place of a `…/projects/:project/launches/stream`
// each. `serve` is JSON, an entry a project, each saying what that project's stream's query would (`home: true` for one
// served from the machine's default folder, `every: true` for `every=1`), and each project is counted as one of its
// launchers just as with its own stream. `ready` {projects: {[project]: {starts, token}}, unknown, version, oldest}: each
// project's starts and the token its claims send, the projects asked for that aren't here (or, on a member's key, aren't
// on their boards); then each served project's launches no launcher has taken yet, and every event its own stream sends,
// each naming its `project`. A project deleted meanwhile is let go; one made later needs the launcher to connect again.
const MOST = 500

export default defineEventHandler(async event => {
    const {serve, version} = getQuery(event)
    let asked: unknown
    try {
        asked = JSON.parse(typeof serve === 'string' ? serve : '')
    } catch {
        throw badRequest('Say what it serves: ?serve=[{"project":"hub","dir":"hub"}, …], as JSON')
    }
    if (!Array.isArray(asked) || asked.length > MOST) throw badRequest(`serve is a list of up to ${MOST} projects`)
    const text = (value: unknown) => typeof value === 'string' && value ? value : undefined
    // One entry a project: a launcher serves each from one folder.
    const entries = new Map<string, LauncherServes>()
    for (const entry of asked) {
        const project = text(entry?.project)
        if (!project || entries.has(project)) continue
        entries.set(project, {project, dir: text(entry.dir), home: entry.home === true, every: entry.every === true, picked: entry.picked, connected: entry.connected})
    }
    const store = useStore()
    const known = new Set((await store.listProjects()).map(p => p.id))
    // A launcher on a member's agent key hears only its own person's launches (ORR-963), and only on their boards.
    const member = launcherMember(event)
    const on = new Set(member ? await store.boardsOf(member, [...entries.keys()].filter(p => known.has(p))) : [...entries.keys()].filter(p => known.has(p)))
    const starts = new Map(await Promise.all([...on].map(async p => [p, await store.starts(p)] as const)))

    const stream = createEventStream(event)
    const served = new Map<string, ReturnType<typeof connectLauncher>>()
    for (const project of on) served.set(project, connectLauncher(entries.get(project) ?? {project}, typeof version === 'string' ? version : '', member))
    const send = (sent: LaunchEvent) => {
        const about = launchEventOn(sent)
        if (served.has(about.project) && hearsLaunch(member, about.id)) stream.push(launchEventSent(sent))
    }
    const removed = (project: string) => {
        served.get(project)?.()
        served.delete(project)
    }
    projectEvents.on('launches', send)
    projectEvents.on('removed', removed)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    const oldest = launcherMinimum((await store.people()).length)
    const projects = Object.fromEntries([...served].map(([project, done]) => [project, {starts: starts.get(project) ?? null, token: done.token}]))
    stream.push({event: 'ready', data: JSON.stringify({projects, unknown: [...entries.keys()].filter(p => !on.has(p)), version: useRuntimeConfig().public.version, oldest})})
    for (const project of served.keys()) {
        // What no launcher has taken yet, such as a launch refused for an outdated launcher that has now restarted (ORR-471).
        for (const launch of unclaimedLaunches(project).filter(l => hearsLaunch(member, l.id))) stream.push({id: launch.id, event: 'launch', data: JSON.stringify(launch)})
        // What it was asked to stop while no launcher was there to hear it (ORR-789).
        for (const id of heldStops(project).filter(id => hearsLaunch(member, id))) stream.push({event: 'stop', data: JSON.stringify({project, id})})
    }
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('launches', send)
        projectEvents.off('removed', removed)
        for (const done of served.values()) done()
        served.clear()
        await stream.close()
    })
    return stream.send()
})
