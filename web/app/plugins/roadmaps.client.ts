import type {Issue, Notice, Project, Schedule, Secret, Session, Settings, Signal} from '#shared/roadmap'

// Loads the projects, then listens to `/api/events`: a change through the API replaces that
// project in place, without a reload. After a dropped connection it loads them all again, and the secrets.
export default defineNuxtPlugin(() => {
    const {projects, ready, live, changed, listeners, launchers, sessions, signals} = useRoadmaps()

    async function load() {
        const app = useAppSettings()
        app.settings.value = await $fetch<Settings>('/api/settings').catch(() => app.settings.value)
        app.apply()
        projects.value = await $fetch<Project[]>('/api/projects', {query: {expand: 'board'}})
        ready.value = true
        useInbox().notices.value = await $fetch<Notice[]>('/api/notices').catch(() => [])
        await useSchedules().load()
        const all = await $fetch<Session[]>('/api/sessions').catch(() => [])
        sessions.value = Object.groupBy(all, s => s.project) as Record<string, Session[]>
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
    function connect() {
        const events = new EventSource('/api/events')
        events.addEventListener('open', () => {
            live.value = 'live'
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
        })
        events.addEventListener('project', event => {
            const project = JSON.parse((event as MessageEvent).data) as Project
            const index = projects.value.findIndex(p => p.id === project.id)
            markChanged(projects.value[index], project)
            useUnseen().ownChanges(project)
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
            sessions.value = {...sessions.value, [project]: now}
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
        })
        events.addEventListener('schedules', event => {
            const {project, schedules} = JSON.parse((event as MessageEvent).data) as {project: string, schedules: Schedule[]}
            const {byProject} = useSchedules()
            byProject.value = {...byProject.value, [project]: schedules}
        })
        events.addEventListener('secrets', event => {
            useSecretList().secrets.value = JSON.parse((event as MessageEvent).data) as Secret[]
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
