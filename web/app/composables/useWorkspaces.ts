import {TINTS} from '#shared/roadmap'

/** A workspace you're in, as `GET /api/workspaces` lists it (ORR-1108). */
export interface Workspace {id: string, name: string, color: string | null, role: 'owner' | 'member'}

/** A workspace's colour as a colour: a named tint's, or the `#rrggbb` itself. */
export function workspaceColor(color: string | null | undefined): string | null {
    return color ? TINTS[color as keyof typeof TINTS] ?? color : null
}

/** Where a page in `workspace` is: `/w/<workspace><path>`. */
export function inWorkspace(workspace: string, path: string): string {
    return `/w/${encodeURIComponent(workspace)}${path === '/' ? '' : path}`
}

// The workspaces you're in, and the one this tab is in (ORR-1108): the tab's address says which (`/w/<workspace>/…`,
// else `default`, or your first when you aren't in `default`), never anything kept between tabs.
export function useWorkspaces() {
    const list = useState<Workspace[]>('workspaces', () => [])
    const loaded = useState('workspaces-loaded', () => false)
    const route = useRoute()

    async function load(again = false) {
        if (loaded.value && !again) return
        list.value = await apiFetch<Workspace[]>('/workspaces').catch(() => [])
        loaded.value = true
    }

    /** The id of the workspace this tab is in. */
    const here = computed(() => workspaceIn(route.path) ?? (list.value.some(w => w.id === 'default') ? 'default' : list.value[0]?.id ?? 'default'))
    const current = computed(() => list.value.find(w => w.id === here.value))

    /** Opens `workspace`'s My issues in this tab: a fresh page, so its settings, colour and boards are all its own. */
    function go(workspace: string, path = '/mine') {
        location.assign(inWorkspace(workspace, path))
    }

    /** Makes a workspace, you its owner, and opens it. */
    async function make(name: string, color?: string | null) {
        const made = await apiFetch<Workspace>('/workspaces', {method: 'POST', body: {name, ...color ? {color} : {}}})
        list.value = [...list.value, made]
        go(made.id)
        return made
    }

    return {list, here, current, load, go, make}
}
