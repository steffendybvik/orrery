import {allIssues} from '~/utils/roadmap'

export const DEMO = 'demo'

// Getting started: the steps from a new orrery to a Claude session working from it, each ticked from what the
// orrery already knows, so none has to be ticked by hand. Someone only planning is set after the first two: the rest
// are for working with Claude. Hiding its card on Now, planning, and the steps for Claude once ticked are remembered in
// this browser.
export function useGettingStarted() {
    const {named, name} = useOwner()
    const {projects, sessions} = useRoadmaps()
    const {ordered} = useProjectOrder()

    const allSessions = computed(() => Object.values(sessions.value).flat())
    // The demo project (useDemoProject) is for trying things; the steps are about your own.
    const own = computed(() => ordered.value.filter(p => p.id !== DEMO))
    // Sessions come and go, so a step once ticked is remembered in this browser, and the steps for Claude also count
    // as done once a later one is: work a session took on means it connected and listened, whatever's live now.
    const seen = useState('getting-started-seen', () => {
        try {
            return JSON.parse(localStorage.getItem('orrery-getting-started-seen') ?? '[]') as string[]
        } catch {
            return []
        }
    })
    const work = computed(() => projects.value.some(p => allIssues(p).some(({issue}) =>
        (issue.kind === 'started' || issue.kind === 'done') && !!issue.assignee && issue.assignee !== name.value)))
    const listen = computed(() => allSessions.value.some(s => s.listening) || seen.value.includes('listen') || work.value)
    const steps = computed(() => [
        {key: 'owner', done: named.value},
        {key: 'project', done: own.value.length > 0},
        // A session in one of its projects has said hello (its hooks or its channel).
        {key: 'connect', done: allSessions.value.length > 0 || seen.value.includes('connect') || listen.value},
        {key: 'listen', done: listen.value},
        // An issue someone other than the owner has taken on: a session started it.
        {key: 'work', done: work.value},
    ])
    watch(steps, now => {
        const ticked = now.filter(s => s.done && (s.key === 'connect' || s.key === 'listen') && !seen.value.includes(s.key))
        if (!ticked.length) return
        seen.value = [...seen.value, ...ticked.map(s => s.key)]
        try {
            localStorage.setItem('orrery-getting-started-seen', JSON.stringify(seen.value))
        } catch {
            // As for hiding.
        }
    }, {immediate: true})
    const done = computed(() => steps.value.filter(s => s.done).length)
    /** The first step not done yet; the last when all are. */
    const current = computed(() => {
        const next = steps.value.findIndex(s => !s.done)
        return next === -1 ? steps.value.length - 1 : next
    })
    /** The steps up to here are all there is to it without Claude. */
    const WITHOUT_CLAUDE = 2
    const planning = useState('getting-started-planning', () => {
        try {
            return localStorage.getItem('orrery-getting-started-planning') === 'yes'
        } catch {
            return false
        }
    })
    const finished = computed(() => done.value === steps.value.length
        || (planning.value && steps.value.slice(0, WITHOUT_CLAUDE).every(s => s.done)))
    /** The project the steps are about: your first in the sidebar. */
    const project = computed(() => own.value[0])

    const hidden = useState('getting-started-hidden', () => {
        try {
            return localStorage.getItem('orrery-getting-started') === 'hidden'
        } catch {
            return false
        }
    })
    /** Just planning: set without the steps for working with Claude; `false` takes them up again. */
    function plan(now = true) {
        planning.value = now
        try {
            if (now) localStorage.setItem('orrery-getting-started-planning', 'yes')
            else localStorage.removeItem('orrery-getting-started-planning')
        } catch {
            // As for hiding.
        }
    }
    /** Hides its card on Now; `false` brings it back, with the steps for working with Claude. */
    function hide(now = true) {
        if (!now) plan(false)
        hidden.value = now
        try {
            if (now) localStorage.setItem('orrery-getting-started', 'hidden')
            else localStorage.removeItem('orrery-getting-started')
        } catch {
            // Private windows may refuse; it stays hidden until a reload.
        }
    }

    return {steps, done, current, finished, project, hidden, hide, planning, plan, WITHOUT_CLAUDE}
}
