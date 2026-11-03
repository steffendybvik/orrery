// Fills an empty playground orrery with a demo, through its API, as the owner (Skoll, the wolf who chases the sun)
// and an agent (claude), with Skoll's brother Hate, who chases the moon, to assign to:
// sessions orrery may start; a prime-number library with shipped, current and planned releases, chunks, sub-issues,
// blocked issues, comment threads, two proposals, a question waiting in the bell, docs in sections and schedules; its
// command line, sharing its releases as a monorepo's app would; graph algorithms with releases of their own. New issues
// go after the ones there, so ids stay put: web/e2e/readme opens PRM-3 and how-the-sieve-works. Its repo is made up, so
// nothing here reaches outside. An orrery that already has projects is left alone.
//   node .playground/seed.mjs [http://localhost:9001]
const base = (process.argv[2] ?? 'http://localhost:9001').replace(/\/+$/, '')
const OWNER = 'skoll'
const HATE = 'hate'
const daysAgo = days => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

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
const factoring = await primes('/chunks', {title: 'Factoring', summary: 'The primes inside a number.'})
const packaging = await primes('/chunks', {title: 'Docs and packaging', summary: 'What it takes for someone else to use it.'})
await primes('/releases', {version: '1.0.0', notes: 'Sieves and a test good enough to ship.'})
await primes('/releases', {version: '0.3.0', position: 1, shipped_on: daysAgo(24), notes: 'A wheel for the sieve, and `is_prime` for anything below 2³².\n\n- The wheel skips multiples of 2, 3 and 5, a third fewer writes\n- `is_prime` no longer sieves to answer one number\n- **Breaking:** `sieve()` is now `primes_up_to()`'})
await primes('/releases', {version: '0.2.0', position: 2, shipped_on: daysAgo(67), notes: 'One bit per odd number, so a sieve to 10⁹ fits in 63 MB.\n\n- Bit-packed storage\n- `nth_prime(n)`\n- Fixed: `count_primes(1)` answered 1'})
await primes('/releases', {version: '0.1.0', position: 3, shipped_on: daysAgo(118), notes: 'The first one: the sieve of Eratosthenes, and enough of an API to call it.'})
await primes('/releases', {version: '1.1.0', notes: 'Factoring, and the sieve on every core.'})

const eratosthenes = await primes('/issues', {title: 'Sieve of Eratosthenes', status: 'done', chunk: sieves.id, release: '0.1.0'}, 'claude')
await primes('/issues', {title: 'Skip the even numbers', status: 'done', parent: eratosthenes.id}, 'claude')
const segmented = await primes('/issues', {title: 'Segmented sieve for n past memory', notes: 'A sieve to 10¹² wants 62 GB in one piece. Sieved a segment at a time, it needs only the primes up to √n and one segment in memory.\n\n**Done when** `primes_up_to(10**12)` runs in under 1 GB and gives the same count as the plain sieve up to 10⁹.', status: 'in-progress', priority: 'P1', assignee: 'claude', chunk: sieves.id, release: '1.0.0', external: ['DEMO-12'], github_issues: [8]}, 'claude')
await primes('/issues', {title: 'Split the range into segments', status: 'done', parent: segmented.id}, 'claude')
await primes('/issues', {title: 'Sieve each segment with the base primes', status: 'in-progress', parent: segmented.id}, 'claude')
await primes('/issues', {title: 'Merge the segments in order', status: 'todo', parent: segmented.id}, 'claude')
const upToTwo = await primes('/issues', {title: 'primes_up_to(2) leaves out 2', notes: '`primes_up_to(2)` returns `[]`. The bound should be inclusive, as it is for every other n.', status: 'todo', priority: 'P0', chunk: sieves.id, labels: ['bug']})
const millerRabin = await primes('/issues', {title: 'Miller–Rabin primality test', notes: 'Answers for one number in O(k log³ n), without a sieve. With the right bases it is deterministic below 2⁶⁴.', status: 'todo', priority: 'P2', chunk: tests.id, release: '1.0.0', labels: ['algorithm']})
const benchmark = await primes('/issues', {title: 'Benchmark against primesieve', status: 'in-review', chunk: sieves.id, release: '1.0.0', assignee: 'claude'}, 'claude')
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
// More of the board, after the ones above so their ids stay: every column, blocked work and sub-issues.
const issue = (body, actor) => primes('/issues', body, actor)
const wheel = await issue({title: 'Wheel factorization for the sieve', status: 'done', chunk: sieves.id, release: '0.3.0', labels: ['performance'], assignee: 'claude'}, 'claude')
await issue({title: 'Skip multiples of 3 and 5', status: 'done', parent: wheel.id}, 'claude')
await issue({title: 'Measure the writes saved', status: 'done', parent: wheel.id}, 'claude')
await issue({title: 'Bit-packed storage', status: 'done', chunk: sieves.id, release: '0.2.0', labels: ['performance'], assignee: 'claude'}, 'claude')
await issue({title: '`nth_prime(n)`', status: 'done', chunk: sieves.id, release: '0.2.0', labels: ['api'], assignee: HATE})
await issue({title: 'count_primes(1) answers 1', status: 'done', chunk: sieves.id, release: '0.2.0', labels: ['bug'], assignee: HATE})
await issue({title: 'First version of the public API', status: 'done', chunk: packaging.id, release: '0.1.0', labels: ['api'], assignee: OWNER})
await issue({title: '`is_prime` below 2³²', status: 'done', chunk: tests.id, release: '0.3.0', labels: ['api', 'algorithm'], assignee: 'claude'}, 'claude')

const parallel = await issue({title: 'Sieve segments on every core', notes: 'Segments share nothing but the base primes, so they should scale close to linearly.', status: 'todo', priority: 'P1', chunk: sieves.id, release: '1.1.0', labels: ['performance'], assignee: 'claude', depends_on: [segmented.id]}, 'claude')
await issue({title: 'Share the base primes between threads', status: 'todo', parent: parallel.id}, 'claude')
await issue({title: 'Hand out segments from a queue', status: 'todo', parent: parallel.id}, 'claude')
await issue({title: 'Hand the merged segments back in order', status: 'backlog', parent: parallel.id}, 'claude')
const bases = await issue({title: 'Deterministic bases below 2⁶⁴', status: 'todo', priority: 'P1', chunk: tests.id, release: '1.0.0', labels: ['algorithm'], assignee: HATE, depends_on: [millerRabin.id]})
await issue({title: 'Baillie–PSW for numbers past 2⁶⁴', status: 'backlog', priority: 'P3', chunk: tests.id, release: '1.1.0', labels: ['algorithm'], depends_on: [bases.id]})
await issue({title: 'Overflow in the modular multiply near 2⁶⁴', status: 'in-progress', priority: 'P0', chunk: tests.id, release: '1.0.0', labels: ['bug'], assignee: HATE})
await issue({title: 'Quick start for the README', status: 'in-progress', priority: 'P2', chunk: packaging.id, release: '1.0.0', labels: ['docs'], assignee: OWNER})
await issue({title: 'Reject a negative bound with a clear error', status: 'in-review', priority: 'P2', chunk: sieves.id, release: '1.0.0', labels: ['bug', 'api'], assignee: 'claude'}, 'claude')
await issue({title: 'Doctests for every public function', status: 'in-review', priority: 'P3', chunk: packaging.id, release: '1.0.0', labels: ['docs'], assignee: HATE})
await issue({title: 'Publish 1.0.0', notes: 'Waits on what 1.0.0 promises: the segmented sieve and numbers we can stand behind.', status: 'todo', priority: 'P1', chunk: packaging.id, release: '1.0.0', assignee: OWNER, depends_on: [segmented.id, benchmark.id, upToTwo.id]})
await issue({title: 'Stable API policy', status: 'todo', priority: 'P2', chunk: packaging.id, release: '1.0.0', labels: ['docs', 'api'], assignee: OWNER})
const rho = await issue({title: "Pollard's rho factorization", notes: 'Trial division up to the sieve, then rho for what is left.', status: 'todo', priority: 'P2', chunk: factoring.id, release: '1.1.0', labels: ['algorithm'], assignee: 'claude', depends_on: [millerRabin.id]}, 'claude')
await issue({title: 'Brent’s cycle detection', status: 'todo', parent: rho.id}, 'claude')
await issue({title: 'Retry with a new constant on failure', status: 'todo', parent: rho.id}, 'claude')
await issue({title: '`factorize(n)` returning primes and powers', status: 'backlog', priority: 'P2', chunk: factoring.id, release: '1.1.0', labels: ['api'], depends_on: [rho.id]})
await issue({title: 'Quadratic sieve for 30 digits and up', status: 'backlog', priority: 'P3', chunk: factoring.id, labels: ['algorithm']})
await issue({title: 'Twin primes iterator', status: 'backlog', priority: 'P3', chunk: sieves.id, labels: ['api']})
await issue({title: 'Sieve on the GPU', status: 'backlog', chunk: sieves.id, labels: ['performance']})
await issue({title: 'AKS primality test', notes: 'Proves primality in polynomial time, and is far too slow next to Miller–Rabin to be worth carrying.', status: 'canceled', chunk: tests.id, labels: ['algorithm']})

await issue({
    title: 'An iterator over primes with no upper bound',
    proposal: 'pending',
    notes: 'People write `primes_up_to` in a loop, doubling the bound, to get "the next prime". An iterator would sieve one segment at a time as it is read, and hold only the base primes.',
    choices: [
        {key: 'shape', question: 'What should it hand back?', pick: 'one', options: [{key: 'ints', title: 'One prime at a time', body: 'The simplest to use, and the slowest'}, {key: 'batches', title: 'A segment’s primes at a time', body: 'Faster, and the caller flattens them'}], recommended: ['ints']},
        {key: 'start', question: 'What can it start from?', pick: 'any', options: [{key: 'two', title: 'From 2'}, {key: 'any', title: 'From any n'}, {key: 'resume', title: 'From a saved position'}], recommended: ['two', 'any']},
    ],
}, 'claude')

// Threads on the issues the pages show. PRM-3's question stays last and Skoll stays out of its thread: anything he said
// after it would answer it, and before it would show on the issue's sessions as not delivered.
const comment = (id, body, actor = 'claude') => primes(`/issues/${id}/comments`, {body}, actor)
await comment(segmented.id, 'Started on this. The plain sieve stays as it is for n below one segment, so small calls cost nothing extra.')
await comment(segmented.id, 'Mind the base primes for n near 2⁶⁴: √n is just under 2³², so there are 203 million of them. That alone is 800 MB as 32-bit ints.', HATE)
await comment(segmented.id, 'Good catch. Kept bit-packed until a segment needs them, they come down to about 256 MB, for one pass to unpack them before the first segment.')
await primes(`/issues/${segmented.id}/comments`, {body: 'Splitting works. Segments of **32 KB** fit the L1 cache; **256 KB** halves the passes over the base primes. Which should be the default?', asks: 'decision'}, 'claude')
await comment(upToTwo.id, 'The bits only hold odd numbers, so 2 is added by hand, and only when `n > 2`. It should be `n >= 2`.', HATE)
await comment(upToTwo.id, 'Worth a test for each n up to 100 against a plain list while you are there.', OWNER)
await comment(millerRabin.id, 'The seven bases 2, 325, 9375, 28178, 450775, 9780504 and 1795265022 are enough below 2⁶⁴. Fewer than the first twelve primes, so it is about 40% quicker.')
await comment(benchmark.id, 'Numbers from one core, 10 runs each, primes up to n:\n\n| n | primes | primesieve | ours |\n|---|---:|---:|---:|\n| 10⁸ | 5,761,455 | 0.03 s | 0.11 s |\n| 10⁹ | 50,847,534 | 0.28 s | 1.2 s |\n| 10¹⁰ | 455,052,511 | 3.1 s | 14 s |\n\nThe counts match. We are about four times slower and use a third of the memory.')
await comment(benchmark.id, 'Four times is fine for 1.0.0, if the docs say so plainly.', OWNER)
await comment(eratosthenes.id, 'Starting the crossing out at p² took a third off the writes.')

// Docs, in sections, for the docs page's sidebar.
await primes('/docs', {id: 'how-the-sieve-works', section: 'Algorithms', title: 'How the sieve works', body: '# How the sieve works\n\nCross out every multiple of each prime p, starting at p², up to n. What is left is prime.\n\n- **Memory:** one bit per odd number, so n / 16 bytes\n- **Time:** O(n log log n)\n- **Past memory:** the segmented sieve does the same a segment at a time, with the primes up to √n kept\n\n## Why start at p²\n\nEvery smaller multiple of p has a smaller prime factor, so it was crossed out already. For p = 7, 14, 21, 28, 35 and 42 went with 2, 3 and 5.\n\n```python\nfrom math import isqrt\n\ndef primes_up_to(n):\n    composite = bytearray(n + 1)\n    for p in range(2, isqrt(n) + 1):\n        if not composite[p]:\n            composite[p * p :: p] = b"\\x01" * (n // p - p + 1)\n    return [p for p in range(2, n + 1) if not composite[p]]\n```\n\n## What it costs\n\n| n | primes | bits | time on one core |\n|---|---:|---:|---:|\n| 10⁸ | 5,761,455 | 6 MB | 0.11 s |\n| 10⁹ | 50,847,534 | 63 MB | 1.2 s |\n| 10¹⁰ | 455,052,511 | 625 MB | 14 s |\n\nSee [Segment sizes](segment-sizes) for how it goes past memory.\n'}, 'claude')
await primes('/docs', {id: 'segment-sizes', section: 'Algorithms', title: 'Segment sizes', body: '# Segment sizes\n\nA segment that fits the L1 cache makes each write cheap. A bigger one makes fewer passes over the base primes. Below about 10¹⁰ the cache wins, and past it the passes do.\n'}, 'claude')
await primes('/docs', {id: 'miller-rabin', section: 'Algorithms', title: 'Miller–Rabin', body: '# Miller–Rabin\n\nWrite n − 1 as 2ˢ·d, with d odd. For a base a, n passes if aᵈ ≡ 1, or a raised to 2ʳ·d ≡ −1 for some r < s, all mod n. A composite passes for at most a quarter of the bases.\n\nWith fixed bases it stops being a matter of chance: seven are enough below 2⁶⁴.\n'}, 'claude')
await primes('/docs', {id: 'getting-started', section: 'Using it', title: 'Getting started', body: '# Getting started\n\n```python\nfrom primes import primes_up_to, is_prime, nth_prime\n\nprimes_up_to(30)   # [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]\nis_prime(2**31 - 1)  # True\nnth_prime(1000)    # 7919\n```\n'}, OWNER)
await primes('/docs', {id: 'api-reference', section: 'Using it', title: 'API reference', body: '# API reference\n\n| | |\n|---|---|\n| `primes_up_to(n)` | every prime up to n, n included |\n| `count_primes(n)` | how many there are, without keeping them |\n| `nth_prime(n)` | the nth prime, from 1 |\n| `is_prime(n)` | whether n is prime, without a sieve |\n'}, 'claude')
await primes('/docs', {id: 'decision-bit-packing', section: 'Decisions', title: 'Decision: one bit per odd number', body: '# Decision: one bit per odd number\n\nDecided for 0.2.0. A byte per number is simpler and quicker to read, but it hits memory at 10¹⁰ on a laptop. Evens are never prime, so they are left out altogether. Reading a bit costs a shift, which the wheel more than pays back.\n'}, OWNER)
await primes('/docs', {id: 'releasing', section: 'Working on Primes', title: 'Releasing', body: '# Releasing\n\n1. Check every issue set for the release is done, or move it on\n2. Run the benchmark, and put the numbers in the notes\n3. Tag it and publish it\n\nCounts are checked against the known values of π(n) up to 10¹² before every tag.\n'}, HATE)

// Schedules for its page, each the owner's so it would run. One has run once, so the page shows a run.
await primes('/schedules', {title: 'Groom the backlog', cron: '0 9 * * 1-5', timezone: 'Europe/Oslo', notes: 'Close what no longer matters, and give the rest a priority.'})
await primes('/schedules', {title: 'Benchmark the sieves each week', cron: '0 9 * * 5', timezone: 'Europe/Oslo', chunk: sieves.id, labels: ['performance'], notes: 'Run the benchmark on the release branch. Say if anything got slower.'})
const triage = await primes('/schedules', {title: 'Triage new bugs', cron: '0 9 * * 1', timezone: 'Europe/Oslo', chunk: sieves.id, priority: 'P2', labels: ['triage'], notes: 'Every open bug should have a priority and a chunk by the end of this.\n\n- [ ] **Reproduce** what came in last week\n- [ ] **Set a priority** on each one'})
await primes('/schedules', {title: 'Check the docs against the API', cron: '0 8 1 * *', timezone: 'Europe/Oslo', chunk: packaging.id, labels: ['docs'], notes: 'Run every example in the docs. Fix what has drifted.'})
await primes('/schedules', {title: 'Count π(10¹²) on the nightly build', cron: '30 2 * * *', timezone: 'Europe/Oslo', chunk: sieves.id, priority: 'P3', enabled: false, notes: 'Should be 37,607,912,018. Paused until the segmented sieve lands.'})
await primes('/schedules', {kind: 'message', title: 'Write up what shipped', on: 'release.shipped', notes: 'A release just shipped. Put what changed in its notes, in plain words.'})
await primes(`/schedules/${triage.id}/run`, {})

// Primes CLI: the library's command line, in the same repo, shipping in its releases.
await call('POST', '/projects', {name: 'Primes CLI', id: 'primes-cli', key: 'CLI', description: 'The primes library on the command line'})
await call('PATCH', '/projects/primes-cli', {release_mode: 'shared', releases_from: 'primes'})
const cli = (path, body, actor) => call('POST', `/projects/primes-cli${path}`, body, actor)
await cli('/issues', {title: '`primes count <n>`', status: 'in-progress', release: '1.0.0', assignee: 'claude'}, 'claude')
await cli('/issues', {title: 'Print as JSON with --json', status: 'todo', priority: 'P2'})
await cli('/issues', {title: '`primes list <n>`', status: 'done', release: '0.2.0', labels: ['command'], assignee: HATE})
await cli('/issues', {title: '`primes is <n>`', status: 'done', release: '0.3.0', labels: ['command'], assignee: 'claude'}, 'claude')
await cli('/issues', {title: 'Exit 1 when `primes is` says no', status: 'in-review', priority: 'P2', release: '1.0.0', labels: ['command'], assignee: HATE})
await cli('/issues', {title: 'Read numbers from stdin', status: 'todo', priority: 'P3', release: '1.0.0', labels: ['command'], assignee: 'claude'}, 'claude')
await cli('/issues', {title: 'Shell completions', status: 'backlog', priority: 'P3', labels: ['packaging']})
await cli('/issues', {title: 'Show progress past 10¹⁰', status: 'todo', priority: 'P2', release: '1.0.0', assignee: HATE, depends_on: [`primes/${segmented.id}`]})
const factorCommand = await cli('/issues', {title: '`primes factor <n>`', status: 'backlog', priority: 'P2', release: '1.1.0', labels: ['command'], depends_on: [`primes/${rho.id}`]})
await cli(`/issues/${factorCommand.id}/comments`, {body: 'Print it as `2^3 × 5` by default, and as a list with `--json`.'}, 'claude')
await cli('/issues', {title: 'A man page', status: 'canceled', labels: ['packaging']})
await cli('/docs', {id: 'commands', section: 'Using it', title: 'Commands', body: '# Commands\n\n```sh\nprimes list 30      # 2 3 5 7 11 13 17 19 23 29\nprimes count 1e9    # 50847534\nprimes is 7919      # yes\n```\n'}, 'claude')
await cli('/schedules', {title: 'Try the commands on a clean machine', cron: '0 7 * * 6', timezone: 'Europe/Oslo', labels: ['packaging'], notes: 'Install it from nothing, and run every example in Commands.'})

// Graphs: a smaller project, with releases of its own.
await call('POST', '/projects', {name: 'Graphs', id: 'graphs', key: 'GRA', description: 'Graph algorithms, one at a time'})
await call('PATCH', '/projects/graphs', {release_mode: 'own'})
const graphs = (path, body, actor) => call('POST', `/projects/graphs${path}`, body, actor)
await graphs('/releases', {version: '0.2.0', notes: 'Shortest paths, weighted and not.'})
await graphs('/releases', {version: '0.1.0', position: 1, shipped_on: daysAgo(40), notes: 'The graph type, and walking one breadth or depth first.'})
const dijkstra = await graphs('/issues', {title: "Dijkstra's shortest paths", status: 'todo', priority: 'P1', assignee: HATE, release: '0.2.0'})
await graphs('/issues', {title: 'Topological sort', status: 'backlog'})
const adjacency = await graphs('/issues', {title: 'Adjacency lists as the graph type', status: 'done', release: '0.1.0', assignee: 'claude'}, 'claude')
await graphs('/issues', {title: 'Breadth-first search', status: 'done', release: '0.1.0', assignee: HATE, depends_on: [adjacency.id]})
await graphs('/issues', {title: 'Depth-first search', status: 'done', release: '0.1.0', assignee: HATE, depends_on: [adjacency.id]})
const heap = await graphs('/issues', {title: 'A binary heap with decrease-key', status: 'in-progress', priority: 'P1', release: '0.2.0', labels: ['performance'], assignee: 'claude'}, 'claude')
await graphs('/issues', {title: 'Sift up after decrease-key', status: 'done', parent: heap.id}, 'claude')
await graphs('/issues', {title: 'Keep each node’s place in the heap', status: 'in-progress', parent: heap.id}, 'claude')
await call('PATCH', `/projects/graphs/issues/${dijkstra.id}`, {depends_on: [heap.id]})
await graphs('/issues', {title: 'Bellman–Ford for negative edges', status: 'in-review', priority: 'P2', release: '0.2.0', labels: ['algorithm'], assignee: HATE})
await graphs('/issues', {title: 'A* with a heuristic you pass in', status: 'todo', priority: 'P3', labels: ['algorithm']})
await graphs('/issues', {title: 'Strongly connected components', status: 'backlog', priority: 'P3', labels: ['algorithm']})
await graphs('/issues', {title: 'Self-loops counted twice in degree()', status: 'todo', priority: 'P0', release: '0.2.0', labels: ['bug'], assignee: OWNER})
await graphs(`/issues/${dijkstra.id}/comments`, {body: 'Not starting until the heap lands: with a plain list it is O(V²), and the benchmark would say so.'}, HATE)
await graphs('/docs', {id: 'choosing-a-shortest-path', section: 'Algorithms', title: 'Choosing a shortest path', body: '# Choosing a shortest path\n\n| The graph | Use |\n|---|---|\n| no weights | breadth-first search |\n| weights of 0 or more | Dijkstra |\n| negative weights | Bellman–Ford |\n'}, 'claude')
await graphs('/schedules', {title: 'Run the big-graph benchmark', cron: '0 6 * * 0', timezone: 'Europe/Oslo', labels: ['performance'], notes: 'A million nodes, five million edges. Say if anything got slower.'})

console.log(`Seeded ${base}: Primes, Primes CLI (sharing its releases) and Graphs (with its own), as Skoll`)
