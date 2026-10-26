// Fills an empty playground Orrery with a demo, through its API, as the owner (Ada Lovelace) and an agent (claude):
// a project with releases, chunks, sub-issues and starts allowed; one sharing its releases, as a monorepo's app
// would; one without releases; a proposal with choices, a question waiting in the bell, and a doc.
// An Orrery that already has projects is left alone.
//   node .playground/seed.mjs [http://localhost:9001]
const base = (process.argv[2] ?? 'http://localhost:9001').replace(/\/+$/, '')
const OWNER = 'ada_lovelace'

async function call(method, path, body, actor = OWNER) {
    const response = await fetch(`${base}/api${path}`, {
        method,
        headers: {'Content-Type': 'application/json', 'Orrery-Actor': actor},
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.status === 204 ? null : response.json()
}

if ((await call('GET', '/projects')).length) {
    console.log(`${base} already has projects; left as it is (.playground/play reset starts over)`)
    process.exit(0)
}

await call('PUT', '/owner', {name: 'Ada Lovelace'})
await call('PATCH', '/settings', {handle: 'ada', tracker: 'https://linear.app/demo/issue/{id}'})

// Larder: its own releases, chunks, and sessions Orrery may start.
await call('POST', '/projects', {name: 'Larder', id: 'larder', key: 'LAR', description: 'What is in the cupboards, and when it runs out'})
await call('PATCH', '/projects/larder', {release_mode: 'own', repo: 'https://github.com/demo/larder', starts: {limit: 2, minutes: 30}})
const larder = (path, body, actor) => call('POST', `/projects/larder${path}`, body, actor)
const shelves = await larder('/chunks', {title: 'Shelves', summary: 'Knowing what is where.'})
const labels = await larder('/chunks', {title: 'Labels', summary: 'Dates and contents on every jar.'})
await larder('/releases', {version: '1.0.0', notes: 'The first one people use.'})

const sort = await larder('/issues', {title: 'Sort the spices by cuisine', status: 'done', chunk: shelves.id, release: '1.0.0'}, 'claude')
await larder('/issues', {title: 'Measure the top shelf', status: 'done', parent: sort.id}, 'claude')
const stock = await larder('/issues', {title: 'Count what is in stock', status: 'in-progress', priority: 'P1', assignee: 'claude', chunk: shelves.id, release: '1.0.0', external: ['DEMO-12']}, 'claude')
await larder('/issues', {title: 'Tins', status: 'done', parent: stock.id}, 'claude')
await larder('/issues', {title: 'Jars', status: 'in-progress', parent: stock.id}, 'claude')
await larder('/issues', {title: 'Bags', status: 'todo', parent: stock.id}, 'claude')
await larder('/issues', {title: 'Flour has run out', status: 'todo', priority: 'P0', chunk: shelves.id})
await larder('/issues', {title: 'Print date labels', status: 'todo', priority: 'P2', chunk: labels.id, release: '1.0.0', labels: ['print']})
await larder('/issues', {title: 'Label the jars', status: 'in-review', chunk: labels.id, release: '1.0.0', assignee: 'claude'}, 'claude')
await larder('/issues', {title: 'A label printer that speaks Bluetooth', status: 'backlog', chunk: labels.id})
await larder('/issues', {title: 'Laminate the labels', status: 'canceled', chunk: labels.id})
await larder('/issues', {
    title: 'Warn before something runs out',
    proposal: 'pending',
    notes: 'Count down from what is used each week, and raise an issue a week before it runs out.',
    choices: [
        {key: 'when', question: 'How early?', pick: 'one', options: [{key: 'week', title: 'A week before'}, {key: 'day', title: 'The day before'}], recommended: ['week']},
        {key: 'how', question: 'How should it tell you?', pick: 'any', options: [{key: 'issue', title: 'An issue'}, {key: 'bell', title: 'The bell'}], recommended: ['issue']},
    ],
}, 'claude')
await larder(`/issues/${stock.id}/comments`, {body: 'Tins are counted. The jars have no dates on them: count them anyway, or wait for **Label the jars**?', asks: 'decision'}, 'claude')
await larder('/docs', {id: 'where-things-go', title: 'Where things go', body: '# Where things go\n\n- **Top shelf:** tins and jars\n- **Middle:** spices, by cuisine\n- **Bottom:** flour, rice and pasta\n'}, 'claude')

// Pantry: an app of the same monorepo, shipping in Larder's releases.
await call('POST', '/projects', {name: 'Pantry', id: 'pantry', key: 'PAN', description: 'The shopping list, from what the larder is missing'})
await call('PATCH', '/projects/pantry', {release_mode: 'shared', releases_from: 'larder'})
await call('POST', '/projects/pantry/issues', {title: 'Make the list from the stock count', status: 'in-progress', release: '1.0.0', assignee: 'claude'}, 'claude')
await call('POST', '/projects/pantry/issues', {title: 'Share the list', status: 'todo', priority: 'P2'})

// Garden: no releases, just a board.
await call('POST', '/projects', {name: 'Garden', id: 'garden', key: 'GAR', description: 'What to sow and when'})
await call('POST', '/projects/garden/issues', {title: 'Sow the tomatoes', status: 'todo', priority: 'P1'})
await call('POST', '/projects/garden/issues', {title: 'Build a cold frame', status: 'backlog'})

console.log(`Seeded ${base}: Larder, Pantry (sharing Larder's releases) and Garden, as Ada Lovelace`)
