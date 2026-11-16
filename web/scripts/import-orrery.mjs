#!/usr/bin/env node
// `pnpm orrery:import --from <url> --to <url> --name <workspace> [--color <tint>]`: brings a whole orrery in as a new
// workspace of another (ORR-1110), so one install holds both. Over HTTP alone, as the owner of both: it only reads the
// source, and on the target it makes the workspace, then carries what's the workspace's (settings, statuses, presets,
// epics, schedules across projects) and uploads each project's board into it (`GET …/export`, then
// `POST /projects/upload?own=1`, which renumbers what's numbered across the server and keeps who said what). A project
// id or key the target already has is renamed, and links to it rewritten. Secrets can't be read back, so it lists them
// to set again. Keys from ORRERY_FROM_KEY and ORRERY_TO_KEY (or --from-key, --to-key); with login off, none.
// Plain Node, no dependencies, so it runs anywhere the repo is checked out.
// The import itself is shared/import-orrery.mjs, which App settings runs on the server too (ORR-1249).
import {client, importOrrery, summary} from '../shared/import-orrery.mjs'

export * from '../shared/import-orrery.mjs'

/** `--name value` and `--flag` from the command line. */
export function parseArgs(argv) {
    const args = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) continue
        const name = arg.slice(2)
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) args[name] = true
        else {
            args[name] = next
            i++
        }
    }
    return args
}

const USAGE = `Usage: pnpm orrery:import --from <source url> --to <target url> --name <workspace name> [--color <tint>]
       [--from-workspace <id>] [--as <person>] [--add] [--dry-run] [--enable-schedules]

Keys: ORRERY_FROM_KEY and ORRERY_TO_KEY (or --from-key, --to-key), each a person key of that orrery's owner;
with login off, none. --as names the person with login off (the owner by default).`

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (args.help || typeof args.from !== 'string' || typeof args.to !== 'string' || typeof args.name !== 'string') {
        console.error(USAGE)
        process.exit(args.help ? 0 : 1)
    }
    // With a key, the key says who's asking; with login off, the person named, else each orrery's owner.
    const connect = async (url, key) => {
        if (key) return client(url, {key})
        const person = typeof args.as === 'string' ? args.as : (await client(url).get('/owner'))?.name
        return client(url, {person})
    }
    const source = await connect(args.from, typeof args['from-key'] === 'string' ? args['from-key'] : process.env.ORRERY_FROM_KEY)
    const target = await connect(args.to, typeof args['to-key'] === 'string' ? args['to-key'] : process.env.ORRERY_TO_KEY)
    if (source.url === target.url) throw new Error('--from and --to are the same orrery')
    const report = await importOrrery({
        source, target, name: args.name, color: typeof args.color === 'string' ? args.color : undefined,
        fromWorkspace: typeof args['from-workspace'] === 'string' ? args['from-workspace'] : 'default',
        add: Boolean(args.add), dryRun: Boolean(args['dry-run']), enableSchedules: Boolean(args['enable-schedules']),
        log: line => console.log(`· ${line}`),
    })
    console.log(`\n${summary(report)}`)
    if (report.projects.some(p => p.error)) process.exit(2)
}

if (process.argv[1] && /import-orrery\.mjs$/.test(process.argv[1])) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
}
