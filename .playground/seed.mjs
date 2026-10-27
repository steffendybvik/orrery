// Fills an empty playground Orrery with a demo, through its API, as the owner (Skoll, the wolf who chases the sun)
// and an agent (claude), with Skoll's brother Hate, who chases the moon, to assign to:
// sessions Orrery may start; a prime-number library with releases, chunks and sub-issues; its command line, sharing its
// releases as a monorepo's app would; graph algorithms with no releases; a proposal with choices, a question
// waiting in the bell, and a doc. An Orrery that already has projects is left alone.
//   node .playground/seed.mjs [http://localhost:9001]
const base = (process.argv[2] ?? 'http://localhost:9001').replace(/\/+$/, '')
const OWNER = 'skoll'

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

await call('PUT', '/owner', {name: 'Skoll'})
await call('PATCH', '/settings', {handle: 'skoll', tracker: 'https://tracker.example.com/issue/{id}', starts: {limit: 2, minutes: 30}})

// Primes: its own releases and chunks.
await call('POST', '/projects', {name: 'Primes', id: 'primes', key: 'PRM', description: 'A library for finding and testing prime numbers'})
await call('PATCH', '/projects/primes', {release_mode: 'own', repo: 'https://github.com/demo/primes'})
const primes = (path, body, actor) => call('POST', `/projects/primes${path}`, body, actor)
const sieves = await primes('/chunks', {title: 'Sieves', summary: 'Every prime up to n, fast.'})
const tests = await primes('/chunks', {title: 'Primality tests', summary: 'Whether one number is prime, without listing the rest.'})
await primes('/releases', {version: '1.0.0', notes: 'Sieves and a test good enough to ship.'})

const eratosthenes = await primes('/issues', {title: 'Sieve of Eratosthenes', status: 'done', chunk: sieves.id, release: '1.0.0'}, 'claude')
await primes('/issues', {title: 'Skip the even numbers', status: 'done', parent: eratosthenes.id}, 'claude')
const segmented = await primes('/issues', {title: 'Segmented sieve for n past memory', status: 'in-progress', priority: 'P1', assignee: 'claude', chunk: sieves.id, release: '1.0.0', external: ['DEMO-12']}, 'claude')
await primes('/issues', {title: 'Split the range into segments', status: 'done', parent: segmented.id}, 'claude')
await primes('/issues', {title: 'Sieve each segment with the base primes', status: 'in-progress', parent: segmented.id}, 'claude')
await primes('/issues', {title: 'Merge the segments in order', status: 'todo', parent: segmented.id}, 'claude')
await primes('/issues', {title: 'primes_up_to(2) leaves out 2', status: 'todo', priority: 'P0', chunk: sieves.id, labels: ['bug']})
await primes('/issues', {title: 'Miller–Rabin primality test', status: 'todo', priority: 'P2', chunk: tests.id, release: '1.0.0', labels: ['algorithm']})
await primes('/issues', {title: 'Benchmark against primesieve', status: 'in-review', chunk: sieves.id, release: '1.0.0', assignee: 'claude'}, 'claude')
await primes('/issues', {title: 'Sieve of Atkin', status: 'backlog', chunk: sieves.id, labels: ['algorithm']})
await primes('/issues', {title: 'Trial division for every n', status: 'canceled', chunk: tests.id})
await primes('/issues', {
    title: 'Keep the primes found between runs',
    proposal: 'pending',
    notes: 'Most calls ask for primes below a bound already sieved. Keeping them would answer those at once.',
    choices: [
        {key: 'where', question: 'Where should they be kept?', pick: 'one', options: [{key: 'memory', title: 'In memory, for the process'}, {key: 'disk', title: 'On disk, across processes'}], recommended: ['memory']},
        {key: 'limit', question: 'How many at most?', pick: 'one', options: [{key: 'million', title: 'Up to 10⁶'}, {key: 'none', title: 'No limit'}], recommended: ['million']},
    ],
}, 'claude')
await primes(`/issues/${segmented.id}/comments`, {body: 'Splitting works. Segments of **32 KB** fit the L1 cache; **256 KB** halves the passes over the base primes. Which should be the default?', asks: 'decision'}, 'claude')
await primes('/docs', {id: 'how-the-sieve-works', title: 'How the sieve works', body: '# How the sieve works\n\nCross out every multiple of each prime p, starting at p², up to n. What is left is prime.\n\n- **Memory:** one bit per odd number, so n / 16 bytes\n- **Time:** O(n log log n)\n- **Past memory:** the segmented sieve does the same a segment at a time, with the primes up to √n kept\n'}, 'claude')

// Primes CLI: the library's command line, in the same repo, shipping in its releases.
await call('POST', '/projects', {name: 'Primes CLI', id: 'primes-cli', key: 'CLI', description: 'The primes library on the command line'})
await call('PATCH', '/projects/primes-cli', {release_mode: 'shared', releases_from: 'primes'})
await call('POST', '/projects/primes-cli/issues', {title: '`primes count <n>`', status: 'in-progress', release: '1.0.0', assignee: 'claude'}, 'claude')
await call('POST', '/projects/primes-cli/issues', {title: 'Print as JSON with --json', status: 'todo', priority: 'P2'})

// Graphs: no releases, just a board.
await call('POST', '/projects', {name: 'Graphs', id: 'graphs', key: 'GRA', description: 'Graph algorithms, one at a time'})
await call('POST', '/projects/graphs/issues', {title: "Dijkstra's shortest paths", status: 'todo', priority: 'P1', assignee: 'hate'})
await call('POST', '/projects/graphs/issues', {title: 'Topological sort', status: 'backlog'})

console.log(`Seeded ${base}: Primes, Primes CLI (sharing its releases) and Graphs, as Skoll`)
