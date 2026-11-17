import type {RouteLocationRaw, Router} from 'vue-router'
import type {Project} from '#shared/roadmap'
import type {Workspace} from '~/composables/useWorkspaces'
import {inWorkspace, OUTSIDE_WORKSPACE, pagePath, WORKSPACE_PAGES, workspaceIn} from '~/utils/api'

// Every page is under its workspace (ORR-1275), and a tab stays in its own:
// - Links in the app are written as the page's path within a workspace (`/projects`, `/p/rockets/issues/RKT-1`), and
//   both their address (a link's href, so opening one in a new tab works) and where they go are put under the tab's
//   workspace, `/w/<workspace>/projects`.
// - An old address, from before pages moved (`/settings`, `/p/rockets/issues/RKT-1`, in a doc, a comment or a
//   notification), goes on to its workspace: a project's page to the project's own workspace, as project ids are
//   unique across the orrery, so no name is in two; any other to the tab's, else the one the API lists first
//   (`default`, else the first by id).
// - A project's page under another workspace than the project's goes to the project's.
// Signing in and connecting are the installation's, so they stay where they are, and an address that was never a
// page (`/nothing-here`) shows as not found where it is. It runs after 01.auth, before the plugins that ask the API.

/** The project a page's path within a workspace is of, if any. */
const projectOf = (path: string) => /^\/p\/([^/?#]+)/.exec(path)?.[1]

export default defineNuxtPlugin(async () => {
    const router = useRouter()
    const roadmaps = useRoadmaps()
    const homes = new Map<string, Promise<string | undefined>>()
    let first: Promise<string> | undefined
    /** The workspace this tab was last in, for links on a page outside every workspace (Connect). */
    const known = ref<string>()

    /** The workspace a project is in: from the projects the page has, else asked. */
    function home(project: string): Promise<string | undefined> {
        const id = decodeURIComponent(project)
        const known = roadmaps.byId(id)?.workspace
        if (known) return Promise.resolve(known)
        const asked = homes.get(id) ?? apiFetch<Project>(`/projects/${encodeURIComponent(id)}`, {query: {notes: '0'}})
            .then(p => p.workspace, () => undefined)
        homes.set(id, asked)
        return asked
    }

    /** The workspace a tab with none in its address is in, as `useWorkspaces().here` takes it. */
    function fallback(): Promise<string> {
        first ??= apiFetch<Workspace[]>('/workspaces').catch(() => [] as Workspace[])
            .then(list => list.some(w => w.id === 'default') ? 'default' : list.map(w => w.id).sort()[0] ?? 'default')
        return first
    }

    /** Where `path` belongs, coming from `from`: under the project's own workspace for one of its pages, else the
     * one in its address, else the tab's, else the first. Undefined for one that isn't a page of a workspace's: a
     * page outside every workspace, or an unknown address, which shows as not found where it is. */
    async function addressOf(path: string, from: string): Promise<string | undefined> {
        if (OUTSIDE_WORKSPACE.includes(path)) return undefined
        const here = workspaceIn(path)
        const within = pagePath(path)
        const top = /^\/([^/?#]*)/.exec(within)?.[1] ?? ''
        if (!here && top && !WORKSPACE_PAGES.includes(top)) return undefined
        const project = projectOf(within)
        const theirs = project ? await home(project) : undefined
        const workspace = theirs ?? here ?? workspaceIn(from) ?? known.value ?? await fallback()
        known.value = workspace
        return inWorkspace(workspace, within)
    }

    // A link's href: the tab's workspace on a path within one, or the last one it was in on a page outside them all.
    // Navigating comes through the guard below as well.
    const resolve = router.resolve.bind(router) as Router['resolve']
    router.resolve = ((to: RouteLocationRaw, current?: Parameters<Router['resolve']>[1]) => {
        const here = workspaceIn((current ?? router.currentRoute.value).path) ?? known.value
        if (here && typeof to === 'string' && to.startsWith('/')) to = inWorkspace(here, to)
        else if (here && typeof to === 'object' && 'path' in to && to.path?.startsWith('/')) to = {...to, path: inWorkspace(here, to.path)}
        return resolve(to, current)
    }) as Router['resolve']

    router.beforeEach(async (to, from) => {
        const path = await addressOf(to.path, from.path)
        // `/w/<workspace>/p/<project>`, as the plan first wrote it, is the project's page too. A push stays a push, so
        // Back still goes to the page before it: a redirect keeps the navigation's own `replace`.
        if (path && path !== to.path) return {path, query: to.query, hash: to.hash}
    })

    // An old address the tab opened on is put right before the other plugins ask the API, which they do in the
    // address's workspace (`apiFetch`): the router's first navigation comes after them.
    const opened = await addressOf(location.pathname, '')
    if (opened && opened !== location.pathname) history.replaceState(history.state, '', opened + location.search + location.hash)
    else if (OUTSIDE_WORKSPACE.includes(location.pathname)) known.value = await fallback()
})
