import type {Schedule, ScheduleAcross, ScheduleRun} from '#shared/roadmap'

/** How long a run's confirmation shows. */
const RAN_FOR = 6000
let ranFor: ReturnType<typeof setTimeout> | undefined

// Every project's schedules, by project, kept current from `/api/events`; and the schedule dialog
// (open for a project, and a schedule to edit, or a new one filled in from a suggestion), the right-click menu, and pausing one.
// And the schedules across projects (ORR-638): one made from one opens that to edit.
export function useSchedules() {
    const byProject = useState<Record<string, Schedule[]>>('schedules', () => ({}))
    const of = (project: string) => byProject.value[project] ?? []
    const across = useState<ScheduleAcross[]>('schedules-across', () => [])
    async function loadAcross() {
        across.value = await apiFetch<ScheduleAcross[]>('/schedules/across').catch(() => across.value)
    }

    async function load() {
        const list = await apiFetch<Schedule[]>('/schedules').catch(() => [] as Schedule[])
        byProject.value = Object.groupBy(list, s => s.project) as Record<string, Schedule[]>
        await loadAcross()
    }

    const editing = useState<{project: string, schedule?: Schedule, draft?: Partial<Schedule>, across?: ScheduleAcross} | null>('schedule-dialog', () => null)
    function edit(project: string, schedule?: Schedule, draft?: Partial<Schedule>) {
        const from = schedule?.across && across.value.find(a => a.id === schedule.across)
        editing.value = from ? {project, across: from} : {project, schedule, draft}
    }
    const editAcross = (from: ScheduleAcross) => editing.value = {project: '', across: from}

    const menu = useState<{schedule: Schedule, x: number, y: number} | null>('schedule-menu', () => null)
    function openMenu(event: MouseEvent, schedule: Schedule) {
        event.preventDefault()
        menu.value = {schedule, x: event.clientX, y: event.clientY}
    }

    /** Pauses a schedule, or resumes it, as the owner; the list catches up from the events. Their own change isn't news. */
    async function pause(schedule: Schedule, paused: boolean) {
        useUnseen().seeSchedule(await apiFetch<Schedule>(`/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}`, {
            method: 'PATCH', body: {enabled: !paused},
        }))
    }

    /** Pauses or activates all of a project's schedules at once, as the owner. Their own change isn't news, though an
     * agent's schedule they hadn't read yet stays marked, as this doesn't read it for them. */
    async function setAll(project: string, enabled: boolean) {
        const {scheduleUnseen, seeSchedule} = useUnseen()
        const unread = new Set(of(project).filter(scheduleUnseen).map(s => s.id))
        const result = await apiFetch<{changed: Schedule[], failed: {id: number, title: string, message: string}[]}>(`/projects/${encodeURIComponent(project)}/schedules/enabled`, {
            method: 'POST', body: {enabled},
        })
        for (const schedule of result.changed) if (!unread.has(schedule.id)) seeSchedule(schedule)
        return result
    }

    /** Makes an agent's schedule the owner's, as they read it (`updated_at`): it runs as theirs from then on (ORR-456). */
    async function adopt(schedule: Schedule): Promise<Schedule> {
        const mine = await apiFetch<Schedule>(`/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}/adopt`, {
            method: 'POST', body: {seen: schedule.updated_at},
        })
        useUnseen().seeSchedule(mine)
        return mine
    }

    /** The last run's confirmation, which goes by itself, shown by ScheduleMenu whatever page it's on (ORR-688). */
    const ran = useState<{text: string, project: string, issue?: string} | null>('schedule-ran', () => null)

    /** Runs a schedule now, on top of its timetable or `instead` of its next run, staying on the page: says what it did, or
     * gives why it failed, which a run can do with the request itself going through. */
    async function run(schedule: Schedule, instead = false): Promise<string | null> {
        try {
            const done = await apiFetch<ScheduleRun>(`/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}/run`, {
                method: 'POST', body: instead ? {instead: true} : undefined,
            })
            const text = ranSaid(done)
            if (!text) return done.note ?? 'The run failed'
            ran.value = {text, project: schedule.project, issue: done.issue}
            clearTimeout(ranFor)
            ranFor = setTimeout(() => ran.value = null, RAN_FOR)
            return null
        } catch (error) {
            return errorMessage(error)
        }
    }

    return {byProject, of, load, across, loadAcross, editing, edit, editAcross, menu, openMenu, pause, setAll, adopt, ran, run}
}
