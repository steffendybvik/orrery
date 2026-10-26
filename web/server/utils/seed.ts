// A demo Orrery, for the dev server (docker-compose.dev.yml sets ORRERY_SEED, and the seed plugin calls this on
// start): an owner, a few projects (an app of its own, and a monorepo whose apps share one release), issues in
// every status, proposals waiting on the owner (with choices, one without a recommendation), comments, a doc
// and a team tracker. An Orrery that already has projects is left alone, so it's safe on every start.
import larderRoadmap from '../../test/fixtures/larder-roadmap.json'
import type {Db} from './database'
import {readRoadmap} from './roadmap'
import type {Actor} from './store'
import {Store} from './store'

const OWNER: Actor = {name: 'demo', owner: true}
const CLAUDE: Actor = {name: 'claude', owner: false}

/** Seeds `db` when it has no projects; says whether it did. */
export async function seed(db: Db): Promise<boolean> {
    const store = new Store(db)
    if ((await store.listProjects()).length) return false
    await store.nameOwner({name: 'Demo'})
    await store.updateSettings({handle: 'demo', tracker: 'https://linear.app/demo/issue/{id}'}, OWNER)

    // An app of its own: the tests' Larder roadmap, with a release and a doc.
    await store.createProject({name: 'Larder', key: 'LAR', description: 'A pantry app: shelves, expiry dates and shopping lists.', icon: 'shopping-cart', icon_color: 'teal', release_mode: 'own'}, OWNER)
    await store.importRoadmap('larder', readRoadmap(JSON.stringify(larderRoadmap)), false, OWNER)
    await store.createRelease('larder', {version: '1.2.0', branch: 'v1.2.0', notes: 'Expiry reminders and the shopping list.'}, OWNER)
    await store.createRelease('larder', {version: '1.1.0', branch: 'v1.1.0', shipped_on: '2026-10-01'}, OWNER)
    const larder = await store.listIssues('larder')
    for (const issue of larder.filter(i => !i.parent).slice(0, 4)) await store.updateIssue('larder', issue.id, {release: '1.2.0'}, OWNER)
    await store.createDoc('larder', {title: 'How expiry dates work', body: '# Expiry dates\n\nEach item keeps the date printed on it. Reminders go out **two days** before, and again on the day.\n\n- Frozen items count from when they went in.\n- An opened jar takes the shorter of its date and a week.'}, CLAUDE)

    // A monorepo: two apps shipping in the repository's release.
    await store.createProject({name: 'Repository', key: 'REP', description: 'The monorepo: shared packages and the release.', icon: 'archive-box', release_mode: 'own'}, OWNER)
    await store.createProject({name: 'Storefront', key: 'SHOP', description: 'The customer-facing shop.', icon: 'building-storefront', icon_color: 'violet', release_mode: 'shared', releases_from: 'repository'}, OWNER)
    await store.createProject({name: 'Admin', key: 'ADM', description: 'The back office.', icon: 'cog-6-tooth', icon_color: 'amber', release_mode: 'shared', releases_from: 'repository'}, OWNER)
    await store.createRelease('repository', {version: '2.25.0', branch: 'release/2.25.0', notes: 'Checkout in one step, and CSV exports.'}, OWNER)
    const make = (project: string, title: string, fields: Record<string, unknown> = {}, actor = CLAUDE) => store.createIssue(project, {title, ...fields}, actor)
    await make('repository', 'Bump the shared dependencies', {status: 'done', release: '2.25.0', labels: ['deps']})
    await make('repository', 'Write the 2.25.0 release notes', {status: 'todo', release: '2.25.0', assignee: 'owner'})
    await store.createChunk('storefront', {title: 'Checkout', summary: 'Paying in one step.', priority: 'P1'}, OWNER)
    const pay = await make('storefront', 'One-step checkout', {chunk: '1', status: 'in-progress', priority: 'P1', assignee: 'claude', release: '2.25.0', external: ['CIR-1567']})
    await make('storefront', 'Remember the card for next time', {parent: pay.id, status: 'done'})
    await make('storefront', 'Show the total before the pay button', {parent: pay.id, status: 'in-review'})
    await make('storefront', 'Offer TWINT to Swiss shoppers', {chunk: '1', status: 'todo', priority: 'P2', release: '2.25.0', labels: ['payments'], external: ['CIR-1570']})
    await make('admin', 'Export orders as CSV', {status: 'in-review', priority: 'P2', release: '2.25.0', labels: ['export']})
    await make('admin', 'Search customers by email', {status: 'backlog', priority: 'P3'})
    await make('admin', 'Dark mode for the settings', {status: 'canceled'})

    // Proposals waiting on the owner: plain, with recommended choices, and one with nothing recommended.
    await make('storefront', 'Show delivery dates on the product page', {proposal: 'pending', priority: 'P2', notes: 'Shoppers ask when it arrives before they buy. Read the carrier\'s estimate and show it under the price.'})
    await make('storefront', 'Save a basket for later', {proposal: 'pending', notes: 'Keep a basket when someone leaves, for when they come back.', choices: [
        {key: 'where', question: 'Where is the basket kept?', pick: 'one', recommended: ['account'], options: [{key: 'account', title: 'On their account', body: 'Follows them across devices; needs them signed in.'}, {key: 'browser', title: 'In the browser', body: 'No sign-in, but one device only.'}]},
        {key: 'how-long', question: 'For how long?', pick: 'one', recommended: ['30'], options: [{key: '7', title: 'A week'}, {key: '30', title: 'A month'}]},
    ]})
    await make('admin', 'Bulk refunds', {proposal: 'pending', notes: 'Refund many orders at once after a bad batch.', choices: [
        {key: 'limit', question: 'How many at once?', pick: 'one', options: [{key: '50', title: 'Up to 50'}, {key: 'all', title: 'Any number'}]},
    ]})
    const asks = await make('larder', 'Pick a reminder time', {status: 'in-progress', assignee: 'claude'})
    await store.createComment('larder', asks.id, {body: 'Should reminders go out in the morning (8:00) or the evening (18:00)? Evening catches people at home, morning lets them plan the day.', asks: 'decision'}, CLAUDE)
    return true
}
