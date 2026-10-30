import type {Chunk, Issue, Place} from '#shared/roadmap'

// A small sample project to try orrery on before connecting a repo (Getting started): a board with issues in
// each status, a sub-issue, chunks, a proposal from Claude and a question waiting in the bell. It's an ordinary
// project the owner made, so its Settings delete it like any other.
export function useDemoProject() {
    const {load} = useOwner()
    const {places} = useStatuses()
    const making = ref(false)
    const failed = ref('')

    async function make(): Promise<string | undefined> {
        making.value = true
        failed.value = ''
        try {
            const owner = {'Orrery-Actor': await load()}
            const claude = {'Orrery-Actor': 'claude'}
            const status = (kind: Place) => places.value.find(p => p.kind === kind)?.id
            const post = <T>(path: string, body: object, headers: Record<string, string> = owner) =>
                apiFetch<T>(`/projects${path}`, {method: 'POST', headers, body})

            const project = await post<{id: string}>('', {name: 'Demo', id: DEMO, key: 'DEM', description: 'A sample board to try orrery on: delete it from its Settings when you like'})
            const at = `/${encodeURIComponent(project.id)}`
            const basics = await post<Chunk>(`${at}/chunks`, {title: 'Getting around', summary: 'Open an issue, move it, give it a priority. Right-click a row for more.'})
            const later = await post<Chunk>(`${at}/chunks`, {title: 'Later'})
            const issue = (body: object, headers?: Record<string, string>) => post<Issue>(`${at}/issues`, body, headers)

            await issue({title: 'Open this issue and read its page', status: status('done'), chunk: basics.id})
            await issue({title: 'Drag me to another column on the board', status: status('started'), priority: 'P1', chunk: basics.id, notes: 'Switch to **Board** above, or right-click the row and pick a status.'})
            // A parent's status follows its sub-issues'.
            const parent = await issue({title: 'Split work into sub-issues', status: status('todo'), chunk: basics.id})
            await issue({title: 'Tick me as done: my parent is done when its sub-issues are', status: status('todo'), parent: parent.id})
            await issue({title: 'Press ⌘K and find this issue by typing "find"', status: status('todo'), priority: 'P2', chunk: basics.id})
            await issue({title: 'Ideas go to the backlog', status: status('backlog'), chunk: later.id})
            // What Claude does: proposes work for you to approve, and asks when it needs you.
            await issue({title: 'Add a dark-mode toggle to the settings page', proposal: 'pending', chunk: later.id, notes: 'Proposed by an agent: approve it, ask for changes, or reject it.'}, claude)
            const asking = await issue({title: 'Pick a default page size', status: status('todo'), chunk: later.id}, claude)
            await post(`${at}/issues/${encodeURIComponent(asking.id)}/comments`, {body: 'Should lists show 25 or 50 rows by default? Answer here and I carry on.', asks: 'decision'}, claude)
            return project.id
        } catch (error) {
            failed.value = errorMessage(error, 'make the demo')
        } finally {
            making.value = false
        }
    }

    return {make, making, failed}
}
