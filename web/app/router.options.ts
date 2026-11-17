import type {RouterConfig} from '@nuxt/schema'
import type {RouteRecordRaw} from 'vue-router'
import {inWorkspace, OUTSIDE_WORKSPACE} from './utils/api'

// Every page lives under its workspace (ORR-1275): `/w/<workspace>/mine`, and a project's at
// `/w/<workspace>/<project>/issues/<id>`, without the `/p` its file is under. The address is what says which workspace a
// tab is in (`workspaceIn`), so two windows can sit in different ones, and nothing about it is kept between tabs. The
// pages outside every workspace (`OUTSIDE_WORKSPACE`) stay where they are, and the old addresses (`/mine`, `/p/…`) are
// sent on to a workspace by plugins/02.workspace.client.ts. Routes keep their names (`p-project-issues-issue`).

/** A route's path under `/w/:workspace`, as `inWorkspace` puts a page there. */
export function underWorkspace(path: string): string {
    if (OUTSIDE_WORKSPACE.includes(path)) return path
    const within = path.replace(/^\/p(?=\/)/, '')
    return `/w/:workspace${within === '/' ? '' : within}`
}

/** A page's `redirect: '/mine'` goes to that page in the same workspace. */
function redirectWithin(redirect: RouteRecordRaw['redirect']): RouteRecordRaw['redirect'] {
    return typeof redirect === 'string' && redirect.startsWith('/')
        ? to => inWorkspace(String(to.params.workspace), redirect)
        : redirect
}

export default {
    routes: routes => routes.map(route => OUTSIDE_WORKSPACE.includes(route.path) ? route : {
        ...route,
        path: underWorkspace(route.path),
        ...route.redirect ? {redirect: redirectWithin(route.redirect)} : {},
    } as RouteRecordRaw),
} satisfies RouterConfig
