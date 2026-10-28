// `pnpm docs:sync <orrery> <project>`: copies the repo's README, changelog and docs (SYNCED) into a project's docs on an
// Orrery, as one step of shipping a release, so the docs there say what's released (ORR-296). A link to another synced
// file goes to its doc page, one to any other file to it on GitHub (`--ref`, main by default), and an image becomes an
// upload, the one already in the doc while it's the same picture. A doc already as the file is left alone.
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {basename, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {SYNCED, pointLinks, titleOf} from './docs-sync-links'

const repo = fileURLToPath(new URL('../..', import.meta.url))

/** The repo on GitHub, from its `origin`. */
function github(): string {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {cwd: repo, encoding: 'utf8'}).trim()
    return origin.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
}

async function main() {
    const args = process.argv.slice(2)
    const option = (name: string) => {
        const at = args.indexOf(`--${name}`)
        return at < 0 ? undefined : args.splice(at, 2)[1]
    }
    const ref = option('ref') ?? 'main'
    const actor = option('actor') ?? 'claude'
    const [orrery, project] = args
    if (!orrery || !project) {
        console.error('Usage: pnpm docs:sync <orrery> <project> [--ref main] [--actor claude]   (e.g. http://localhost:9000 orrery)')
        process.exit(1)
    }
    const headers = {'Content-Type': 'application/json', 'Orrery-Actor': actor}
    const api = async (path: string, init?: RequestInit) => {
        const response = await fetch(`${orrery.replace(/\/$/, '')}/api${path}`, {...init, headers})
        if (!response.ok && response.status !== 404) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
        return response
    }
    const site = github()
    console.log(`Syncing ${Object.keys(SYNCED).length} files into ${orrery} project ${project} (other files: ${site}/blob/${ref})`)

    for (const [file, id] of Object.entries(SYNCED)) {
        const text = readFileSync(resolve(repo, file), 'utf8')
        const was = await api(`/projects/${project}/docs/${id}`)
        const before = was.ok ? await was.json() as {title: string, body: string} : null
        // The doc's own uploads, to keep one that's still the same picture.
        const uploads = [...new Set((before?.body ?? '').match(/\/api\/uploads\/[a-f0-9]+/g) ?? [])]
        const images = new Map<string, string>()
        const wanted: string[] = []
        pointLinks(text, file, (path, image) => {
            if (image) wanted.push(path)
            return null
        })
        for (const path of new Set(wanted)) {
            if (!existsSync(resolve(repo, path))) continue
            const bytes = readFileSync(resolve(repo, path))
            let url: string | undefined
            for (const upload of uploads) {
                const kept = await api(upload.slice('/api'.length))
                if (kept.ok && Buffer.from(await kept.arrayBuffer()).equals(bytes)) url = upload
                if (url) break
            }
            url ??= (await (await api('/uploads', {method: 'POST', body: JSON.stringify({name: basename(path), data: bytes.toString('base64')})})).json() as {url: string}).url
            images.set(path, url)
        }
        const body = pointLinks(text, file, (path, image) => image
            ? images.get(path) ?? null
            : SYNCED[path] ? `/p/${project}/docs/${SYNCED[path]}` : existsSync(resolve(repo, path)) ? `${site}/blob/${ref}/${path}` : null)
        const title = titleOf(text, file)
        if (before?.title === title && before.body === body) {
            console.log(`  ${id.padEnd(14)} unchanged`)
            continue
        }
        await api(`/projects/${project}/docs/${id}`, {method: 'PUT', body: JSON.stringify({title, body})})
        console.log(`  ${id.padEnd(14)} ${before ? 'updated' : 'made'}`)
    }
    console.log('Done.')
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
