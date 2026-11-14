import {inWorkspace} from '~/composables/useWorkspaces'

// A tab stays in its workspace (ORR-1108): a link to `/projects` from a page under `/w/<workspace>/…` goes to
// `/w/<workspace>/projects`, so every NuxtLink and navigateTo keeps the workspace without naming it. Signing in and
// connecting are the installation's, so they stay where they are.
const OUTSIDE = new Set(['/login', '/connect'])

export default defineNuxtPlugin(() => {
    useRouter().beforeEach((to, from) => {
        const workspace = workspaceIn(from.path)
        if (!workspace || workspaceIn(to.path) || OUTSIDE.has(to.path)) return
        return {path: inWorkspace(workspace, to.path), query: to.query, hash: to.hash, replace: true}
    })
})
