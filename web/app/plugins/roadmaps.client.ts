import type {Chat, Issue, LoggedEvent, Notice, Project, Schedule, Secret, Session, Settings, Signal} from '#shared/roadmap'
import type {ProjectPatch} from '#shared/patch'
import {applyPatch} from '#shared/patch'

// Loads the projects, without their closed issues (ORR-447), and reads one whole as one of its pages opens; then listens
// to `/api/events`: a change through the API comes as a patch of what changed in
// the project (ORR-440), which replaces it in place, without a reload (and the owner's chats, as they change). After a dropped connection it loads them all again, and the secrets; one
// the browser gave up on (refused while the server restarted) it opens again itself.
export default defineNuxtPlugin(() => {
    // On the login page there's nothing yet it may read.
    if (useAuth().loggedOut.value) return
    const {projects, ready, live, changed, listeners, launchers, sessions, chatSessions, signals, partial, whole} = useRoadmaps()
    const router = useRouter()
    /** The project the page is on, read whole once the projects are in, and those it shares releases with, whose
     * issues its release pages show. */
    const wholeForPage = () => {
        const id = router.currentRoute.value.params.project
        if (typeof id !== 'string' || !ready.value) return
        const project = projects.value.find(p => p.id === id)
        const sharing = projects.value.filter(p => p.releases_from === id || p.id === project?.releases_from || project?.releases_from && p.releases_from === project.releases_from)
        for (const p of new Set([id, ...sharing.map(p => p.id)])) whole(p).catch(() => {})
    }
    watch(() => router.currentRoute.value.params.project, wholeForPage)

    async function load() {
        const app = useAppSettings()
        app.settings.value = await $fetch<Settings>('/api/settings').catch(() => app.settings.value)
        app.apply()
        await useOwner().refresh()
        // The page's own project comes whole in the same call.
        const here = router.currentRoute.value.params.project
        const own = typeof here === 'string' ? here : undefined
        const read = await $fetch<(Project & {rev: number})[]>('/api/projects', {query: {expand: 'board', notes: '0', closed: '0', ...own ? {whole: own} : {}}})
        revs.clear()
        for (const project of read) revs.set(project.id, project.rev)
        partial.value = Object.fromEntries(read.map(p => [p.id, p.id !== own]))
        projects.value = read
        ready.value = true
        wholeForPage()
        useInbox().notices.value = await $fetch<Notice[]>('/api/notices').catch(() => [])
        await useLoggedEvents().loadNew()
        await useSchedules().load()
        await useChat().fetchChats()
        const all = await $fetch<Session[]>('/api/sessions').catch(() => [])
        // Under each project it's on, as the `sessions` event lists them: its own and the others its channel hears.
        const grouped: Record<string, Session[]> = {}
        for (const s of all) for (const p of [s.project, ...s.also ?? []]) (grouped[p] ??= []).push(s)
        sessions.value = Object.fromEntries(Object.entries(grouped).map(([p, list]) => [p, list.filter(s => !s.started?.chat)]))
        chatSessions.value = Object.fromEntries(Object.entries(grouped).map(([p, list]) => [p, list.filter(s => s.started?.chat)]))
    }

    /** The issues whose `updated_at` moved, so their rows can flash. */
    function markChanged(before: Project | undefined, after: Project) {
        const stamps = new Map<string, string>()
        const walk = (issues: Issue[], visit: (issue: Issue) => void) => issues.forEach(i => {
            visit(i)
            walk(i.tasks, visit)
        })
        before?.board.chunks.forEach(c => walk(c.tasks, i => stamps.set(i.id, i.updated_at)))
        const now = Date.now()
        const next = {...changed.value}
        after.board.chunks.forEach(c => walk(c.tasks, i => {
            if (before && stamps.get(i.id) !== i.updated_at) next[`${after.id}/${i.id}`] = now
        }))
        changed.value = next
    }

    /** The revision of each project the page has, which the next patch to it must build on. */
    const revs = new Map<string, number>()

    /** A project as it is now, from a patch or read whole: in place, with its changed rows flashing. */
    function received(project: Project) {
        const index = projects.value.findIndex(p => p.id === project.id)
        markChanged(projects.value[index], project)
        useUnseen().ownChanges(project)
        useInbox().projectChanged(project)
        if (index < 0) projects.value = [...projects.value, project].sort((a, b) => a.name.localeCompare(b.name))
        else projects.value = projects.value.map(p => p.id === project.id ? project : p)
    }

    /** Applies a patch to the project the page has; one it can't (it missed one, or doesn't have what the patch counts
     * on) has the project read again whole. One the page is already past (it read the project whole since) is dropped. */
    function patched(patch: ProjectPatch) {
        const before = projects.value.find(p => p.id === patch.id)
        const have = revs.get(patch.id)
        if (before && have !== undefined && patch.rev <= have) return
        const fits = before ? have !== undefined && patch.base <= have : patch.base === 0
        const lacking = !!partial.value[patch.id]
        const project = fits ? applyPatch(before ?? {board: {chunks: []}} as unknown as Project, patch, lacking) : null
        if (project) {
            revs.set(patch.id, Math.max(have ?? 0, patch.rev))
            return received(project)
        }
        // Read again as the page has it: without its closed issues while it was.
        $fetch<Project & {rev: number}>(`/api/projects/${encodeURIComponent(patch.id)}`, {query: {notes: '0', ...lacking ? {closed: '0'} : {}}}).then(read => {
            revs.set(read.id, Math.max(revs.get(read.id) ?? 0, read.rev))
            received(read)
        }, () => {})
    }

    let opened = false
    /** How long to wait before opening a stream the browser gave up on again, longer each time. */
    let wait = 1000
    function connect() {
        const events = new EventSource('/api/events?patch=1')
        events.addEventListener('open', () => {
            live.value = 'connected'
            wait = 1000
            // A secret removed while offline would otherwise show until a reload.
            if (opened) Promise.all([load(), useSecretList().load()]).catch(() => {})
            opened = true
        })
        events.addEventListener('ready', event => {
            const build = (event as MessageEvent).data as string
            if (build && build !== useRuntimeConfig().app.buildId) location.reload()
        })
        events.addEventListener('error', () => {
            // Connecting… only until the first open; after a drop the browser is trying again.
            live.value = events.readyState === EventSource.CLOSED ? 'offline' : opened ? 'reconnecting' : 'connecting'
            if (events.readyState !== EventSource.CLOSED) return
            setTimeout(connect, wait)
            wait = Math.min(wait * 2, 30_000)
        })
        events.addEventListener('patch', event => patched(JSON.parse((event as MessageEvent).data) as ProjectPatch))
        events.addEventListener('listeners', event => {
            const {project, count} = JSON.parse((event as MessageEvent).data) as {project: string, count: number}
            listeners.value = {...listeners.value, [project]: count}
        })
        events.addEventListener('launchers', event => {
            const {project, count} = JSON.parse((event as MessageEvent).data) as {project: string, count: number}
            launchers.value = {...launchers.value, [project]: count}
        })
        events.addEventListener('sessions', event => {
            const {project, sessions: now} = JSON.parse((event as MessageEvent).data) as {project: string, sessions: Session[]}
            // The owner's chats apart, as they're not listed with the rest.
            sessions.value = {...sessions.value, [project]: now.filter(s => !s.started?.chat)}
            chatSessions.value = {...chatSessions.value, [project]: now.filter(s => s.started?.chat)}
        })
        events.addEventListener('signal', event => {
            const signal = JSON.parse((event as MessageEvent).data) as Signal
            signals.value = [signal, ...signals.value.filter(s => s.id !== signal.id)].slice(0, 200)
        })
        events.addEventListener('notice', event => {
            useInbox().arrived(JSON.parse((event as MessageEvent).data) as Notice)
        })
        events.addEventListener('settings', event => {
            useAppSettings().heard(JSON.parse((event as MessageEvent).data) as Settings)
            // They come with renaming the owner, whose id this tab writes as.
            useOwner().refresh()
        })
        events.addEventListener('schedules', event => {
            const {project, schedules} = JSON.parse((event as MessageEvent).data) as {project: string, schedules: Schedule[]}
            const {byProject} = useSchedules()
            byProject.value = {...byProject.value, [project]: schedules}
            void useSchedules().loadAcross()
        })
        events.addEventListener('secrets', event => {
            useSecretList().secrets.value = JSON.parse((event as MessageEvent).data) as Secret[]
        })
        events.addEventListener('logged', event => {
            const {event: logged, fresh} = JSON.parse((event as MessageEvent).data) as {event: LoggedEvent, fresh: boolean}
            useLoggedEvents().arrived(logged, fresh)
        })
        events.addEventListener('chat', event => {
            useChat().arrived(JSON.parse((event as MessageEvent).data) as Chat)
        })
        events.addEventListener('removed', event => {
            const id = (event as MessageEvent).data as string
            revs.delete(id)
            projects.value = projects.value.filter(p => p.id !== id)
        })
    }

    load().catch(() => {
        ready.value = true
    })
    connect()
})
