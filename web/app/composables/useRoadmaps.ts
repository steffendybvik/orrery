import type {Project, Session, Signal} from '#shared/roadmap'

// Every project with its board, loaded once and kept current by `/api/events` (see the
// `roadmaps` plugin). `changed` holds the ids of issues that just changed, so rows can flash.
export function useRoadmaps() {
    const projects = useState<Project[]>('projects', () => [])
    const ready = useState('projects-ready', () => false)
    const live = useState<'connecting' | 'live' | 'offline'>('projects-live', () => 'connecting')
    const changed = useState<Record<string, number>>('projects-changed', () => ({}))
    /** How many Claude sessions listen for each project's signals (known for projects asked about). */
    const listeners = useState<Record<string, number>>('projects-listeners', () => ({}))
    /** How many launchers that start sessions are connected for each project (known once one comes or goes). */
    const launchers = useState<Record<string, number>>('projects-launchers', () => ({}))
    /** The Claude sessions on each project, as their hooks and channels last said. Not the owner's chats: they count
     * towards nothing and aren't listed, so they're kept apart, in `chatSessions` (the chat pane's). */
    const sessions = useState<Record<string, Session[]>>('projects-sessions', () => ({}))
    const chatSessions = useState<Record<string, Session[]>>('projects-chat-sessions', () => ({}))
    /** Signals as they're sent and delivered, latest first (what the issue pages show). */
    const signals = useState<Signal[]>('projects-signals', () => [])

    const byId = (id: string | undefined) => projects.value.find(p => p.id === id)
    /** Loads one project afresh and puts it in place: for when its update hasn't come yet (a page opened right
     * after a write), or won't (offline). Nothing when it can't be loaded. */
    async function reload(id: string): Promise<Project | undefined> {
        const project = await $fetch<Project>(`/api/projects/${encodeURIComponent(id)}`).catch(() => undefined)
        if (project) {
            projects.value = byId(id) ? projects.value.map(p => p.id === id ? project : p)
                : [...projects.value, project].sort((a, b) => a.name.localeCompare(b.name))
        }
        return project
    }
    return {projects, ready, live, changed, listeners, launchers, sessions, chatSessions, signals, byId, reload}
}
