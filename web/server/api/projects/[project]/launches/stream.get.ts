import type {LaunchEvent} from '../../../../utils/launches'
import {launcherMinimum} from '#shared/version'

// `GET /api/projects/:project/launches/stream?dir=&every=1&version=&picked=` → server-sent events for the project's launcher
// (channel/orrery-launcher.mjs) on the host, running in the folder `dir` (projects served from one folder can share a
// session), or with `home=1` from its machine's default folder, as the project has no repo there (ORR-1066), when a
// launcher in its repo is given its sessions first, with `every` where its channel serves every project (`*`), `version` its code's, `picked` when its channel picked the repo up (ORR-605), and `connected` when Connect a repo added it (ORR-774): `ready` {project, starts,
// version, oldest, token}, the orrery's version among them and the oldest launcher it takes (ORR-965), and the token its claims send (`Orrery-Launcher`), so a launcher on older code knows to restart once it can; then each of the project's launches no launcher has taken yet; `launch` {id, project, after, minutes?, tmux, context?, hears?}, a session to start
// once it has claimed it (no minutes: until stopped); `stop` {id}, one of its sessions to stop (the owner stopped
// it, also while no launcher was connected, or it's done and its time is up or it sat idle too long); `extend` {id, stops_at}, the owner giving one longer; `clear` {id}, one of its sessions done with a piece of work, to `/clear` for a fresh context; `watch` {id, terminal}, the owner pressing Watch, to open a terminal on it in that app; `view` {id}, the owner viewing its screen, to send it (POST …/screen) until nobody is.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const starts = await useStore().starts(project)
    const stream = createEventStream(event)
    const {dir, every, version, picked, connected, home} = getQuery(event)
    // A launcher on a member's agent key hears only its own person's launches, and isn't counted as the project's (ORR-963).
    const member = launcherMember(event)
    const done = connectLauncher({project, dir: typeof dir === 'string' ? dir : undefined, every: every === '1', home: home === '1', picked, connected}, typeof version === 'string' ? version : '', member)
    const send = (sent: LaunchEvent) => {
        const on = launchEventOn(sent)
        if (on.project === project && hearsLaunch(member, on.id)) stream.push(launchEventSent(sent))
    }
    projectEvents.on('launches', send)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    const oldest = launcherMinimum((await useStore().people()).length)
    stream.push({event: 'ready', data: JSON.stringify({project, starts: starts ?? null, version: useRuntimeConfig().public.version, oldest, token: done.token})})
    // What no launcher has taken yet, such as a launch refused for an outdated launcher that has now restarted (ORR-471).
    for (const launch of unclaimedLaunches(project).filter(l => hearsLaunch(member, l.id))) stream.push({id: launch.id, event: 'launch', data: JSON.stringify(launch)})
    // What it was asked to stop while no launcher was there to hear it (ORR-789).
    for (const id of heldStops(project).filter(id => hearsLaunch(member, id))) stream.push({event: 'stop', data: JSON.stringify({project, id})})
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('launches', send)
        done()
        await stream.close()
    })
    return stream.send()
})
