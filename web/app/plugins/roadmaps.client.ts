import type {Chat, Issue, LoggedEvent, Notice, Project, Schedule, Secret, Session, Settings, Signal} from '#shared/roadmap'

// Loads the projects, then listens to `/api/events`: a change through the API replaces that
// project in place, without a reload (and the owner's chats, as they change). After a dropped connection it loads them all again, and the secrets; one
// the browser gave up on (refused while the server restarted) it opens again itself.
export default defineNuxtPlugin(() => {
    const {projects, ready, live, changed, listeners, launchers, sessions, chatSessions, signals} = useRoadmaps()

    async function load() {
        const app = useAppSettings()
        app.settings.value = await $fetch<Settings>('/api/settings').catch(() => app.settings.value)
        app.apply()
        await useOwner().refresh()
        projects.value = await $fetch<Project[]>('/api/projects', {query: {expand: 'board'}})
        ready.value = true
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

    let opened = false
    /** How long to wait before opening a stream the browser gave up on again, longer each time. */
    let wait = 1000
    function connect() {
        const events = new EventSource('/api/events')
        events.addEventListener('open', () => {
            live.value = 'live'
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
            live.value = events.readyState === EventSource.CLOSED ? 'offline' : 'connecting'
            if (events.readyState !== EventSource.CLOSED) return
            setTimeout(connect, wait)
            wait = Math.min(wait * 2, 30_000)
        })
        events.addEventListener('project', event => {
            const project = JSON.parse((event as MessageEvent).data) as Project
            const index = projects.value.findIndex(p => p.id === project.id)
            markChanged(projects.value[index], project)
            useUnseen().ownChanges(project)
            useInbox().projectChanged(project)
            if (index < 0) projects.value = [...projects.value, project].sort((a, b) => a.name.localeCompare(b.name))
            else projects.value = projects.value.map(p => p.id === project.id ? project : p)
        })
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
            const app = useAppSettings()
            app.settings.value = JSON.parse((event as MessageEvent).data) as Settings
            app.apply()
            // They come with renaming the owner, whose id this tab writes as.
            useOwner().refresh()
        })
        events.addEventListener('schedules', event => {
            const {project, schedules} = JSON.parse((event as MessageEvent).data) as {project: string, schedules: Schedule[]}
            const {byProject} = useSchedules()
            byProject.value = {...byProject.value, [project]: schedules}
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
            projects.value = projects.value.filter(p => p.id !== id)
        })
    }

    load().catch(() => {
        ready.value = true
    })
    connect()
})
