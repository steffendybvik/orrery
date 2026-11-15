import type {RouterConfig} from '@nuxt/schema'

// Every page is also at `/w/<workspace>/…` (ORR-1108, decision-workspaces step 5): the same page, its route and name
// unchanged, with the workspace in the address. The address is what says which workspace a tab is in (`workspaceIn`),
// so two windows can sit in different ones, and nothing about it is kept between tabs.
export default {
    routes: routes => routes.map(route => route.path.startsWith('/w/') ? route : {
        ...route,
        alias: [...[route.alias ?? []].flat(), `/w/:workspace${route.path === '/' ? '' : route.path}`],
    }),
} satisfies RouterConfig
