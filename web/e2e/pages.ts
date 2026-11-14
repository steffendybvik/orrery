import type {APIRequestContext, Page} from '@playwright/test'
import {AGENT, makeProject, projectApi} from './support'

// Every page of the app, as the page walks open them (ORR-580): navigation.spec.ts, and the slow read-only walks in
// a11y.spec.ts, split off so a run can take them side by side (ORR-920). Each walk makes a project of its own with the
// same things in it, so the two never wait on each other. A new page is a line here; test/page-specs.test.ts holds
// every page to these lists.

export interface Route {
    path: string
    heading: string
    /** The sidebar entry that leads here and is active on it, by its link's text. */
    sidebar?: string
    /** The ⌘K palette's entry for it: in Go to, or found by typing it. */
    palette?: string
    /** Its sidebar entry shows only while Advanced is on (ORR-578). */
    advanced?: true
}

/** A walk's project, and what it made in it. */
export interface Walked {
    id: string
    name: string
    milestone: string
    doc: string
    issue: string
    epic: number
}

export const ROUTES = (w: Walked): Route[] => [
    {path: '/mine', heading: 'My issues', sidebar: 'My issues', palette: 'My issues and urgent'},
    {path: '/projects', heading: 'Projects', sidebar: 'Projects', palette: 'Projects'},
    {path: '/connect', heading: 'Connect an agent', sidebar: 'Connect an agent', palette: 'Connect an agent'},
    {path: '/sessions', heading: 'Sessions', sidebar: 'Sessions', palette: 'Sessions'},
    {path: '/schedules', heading: 'Schedules', sidebar: 'Schedules', palette: 'Schedules'},
    {path: '/releases', heading: 'Releases', sidebar: 'Releases', palette: 'Releases'},
    {path: '/epics', heading: 'Epics', sidebar: 'Epics', palette: 'Epics'},
    {path: `/epics/${w.epic}`, heading: 'Survey the coasts', sidebar: 'Epics'},
    {path: '/events', heading: 'Events', sidebar: 'Events', palette: 'Events', advanced: true},
    {path: '/context', heading: 'Context', sidebar: 'Context', palette: 'Context', advanced: true},
    {path: '/pulls', heading: 'Pull requests', sidebar: 'Pull requests', palette: 'Pull requests', advanced: true},
    {path: '/notifications', heading: 'Notifications', palette: 'Notifications'},
    {path: '/getting-started', heading: 'Getting started', palette: 'Getting started'},
    {path: '/settings', heading: 'Your name', palette: 'App settings'},
    {path: '/settings?tab=issues', heading: 'Team tracker'},
    {path: '/settings?tab=orrery', heading: 'Background tint'},
    {path: '/settings?tab=advanced', heading: 'Pull requests'},
    {path: `/p/${w.id}`, heading: w.name, sidebar: 'Issues', palette: w.name},
    {path: `/p/${w.id}?view=board`, heading: w.name, sidebar: 'Issues'},
    {path: `/p/${w.id}/roadmap`, heading: w.name, sidebar: 'Roadmap', palette: `${w.name} roadmap`},
    {path: `/p/${w.id}/roadmap/${w.milestone}`, heading: 'Coastlines', sidebar: 'Roadmap', palette: 'Coastlines'},
    {path: `/p/${w.id}/releases`, heading: w.name, sidebar: 'Releases', palette: `${w.name} releases`},
    {path: `/p/${w.id}/releases/2.0.0`, heading: '2.0.0', sidebar: 'Releases'},
    // Docs opens on the first doc, whose title is the page's h1 (ORR-623).
    {path: `/p/${w.id}/docs`, heading: 'Projections', sidebar: 'Docs', palette: `${w.name} docs`},
    {path: `/p/${w.id}/docs/${w.doc}`, heading: 'Projections', sidebar: 'Docs', palette: 'Projections'},
    {path: `/p/${w.id}/settings`, heading: w.name, sidebar: 'Settings', palette: `${w.name} settings`},
    {path: `/p/${w.id}/issues/${w.issue}`, heading: 'Chart the fjords', sidebar: 'Issues', palette: 'Chart the fjords'},
]

/** Addresses that only go on to a page, from old links and bookmarks. */
export const REDIRECTS = (w: Walked) => [
    {from: '/', to: /\/mine$/},
    {from: '/now', to: /\/mine$/},
    {from: '/urgent', to: /\/mine$/},
    {from: `/p/${w.id}/schedules`, to: new RegExp(`/schedules\\?project=${w.id}$`)},
    {from: `/p/${w.id}/issues`, to: new RegExp(`/p/${w.id}$`)},
]

export const heading = (page: Page, name: string) => page.getByRole('heading', {name, exact: true}).first()

/** Makes the walk's project and what its pages show, or finds them: once a test fails, the next starts on a fresh worker,
 * which runs this again on the same orrery. `name` is its name, whose lowercase is its id. */
export async function walkProject(request: APIRequestContext, name: string, key: string): Promise<Walked> {
    const id = name.toLowerCase()
    const api = projectApi(id)
    // The epic is the whole orrery's, so each walk's is found by its project's issue.
    if ((await request.get(`/api/projects/${id}`)).ok()) {
        const issue = (await api(request, 'get', '/issues?q=fjords') as {id: string, epic?: number}[])[0]!
        return {
            id, name, issue: issue.id, epic: issue.epic!,
            milestone: String((await api(request, 'get', '/milestones') as {id: number, title: string}[]).find(c => c.title === 'Coastlines')!.id),
            doc: (await api(request, 'get', '/docs') as {id: string, title: string}[]).find(d => d.title === 'Projections')!.id,
        }
    }
    await makeProject(request, {name, key, release_mode: 'own'})
    const milestone = String((await api(request, 'post', '/milestones', {title: 'Coastlines'})).id)
    const doc = (await api(request, 'post', '/docs', {title: 'Projections', body: 'Mercator, mostly.'})).id
    await api(request, 'post', '/releases', {version: '2.0.0'})
    const epic = (await (await request.post('/api/epics', {data: {title: 'Survey the coasts'}, headers: AGENT})).json() as {id: number}).id
    const issue = (await api(request, 'post', '/issues', {title: 'Chart the fjords', milestone, epic})).id
    // What the contrast pass has to see (ORR-855): a row waiting on a decision, a schedule that has run and one paused.
    const waiting = (await api(request, 'post', '/issues', {title: 'Pick a projection', milestone, status: 'in-progress'})).id
    await api(request, 'post', `/issues/${waiting}/comments`, {body: 'Mercator or Robinson?', asks: 'decision'})
    const ran = await api(request, 'post', '/schedules', {title: 'Survey the coast', cron: '0 9 * * *', timezone: 'UTC'})
    await api(request, 'post', `/schedules/${ran.id}/run`)
    await api(request, 'post', '/schedules', {title: 'Redraw the borders', cron: '0 9 * * 1', timezone: 'UTC', enabled: false})
    return {id, name, milestone, doc, issue, epic}
}
