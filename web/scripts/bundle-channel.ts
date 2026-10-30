// The channel, hook and launcher as single files with no dependencies, for the orrery to serve (ORR-435, server/routes/channel),
// beside the bootstrap that runs them and a manifest of what's there. Run by `nuxt dev` and `nuxt build` (nuxt.config.ts).
import {createHash} from 'node:crypto'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'

const channel = fileURLToPath(new URL('../../channel', import.meta.url))
const SCRIPTS = ['orrery-channel.mjs', 'orrery-hook.mjs', 'orrery-launcher.mjs']

/** Writes them to `out`; `version` is what they report. */
export async function bundleChannel(out: string, version: string) {
    mkdirSync(out, {recursive: true})
    await build({
        entryPoints: SCRIPTS.map(script => join(channel, script)),
        outdir: out,
        outExtension: {'.js': '.mjs'},
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'warning',
        define: {__ORRERY_VERSION__: JSON.stringify(version)},
        // What the channel's packages `require`, which an ES module doesn't have.
        banner: {js: "import {createRequire as orreryRequire} from 'node:module';const require=orreryRequire(import.meta.url);"},
    })
    const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
    writeFileSync(join(out, 'bootstrap.mjs'), readFileSync(join(channel, 'bootstrap.mjs')))
    const files = Object.fromEntries(SCRIPTS.map(script => [script, hash(readFileSync(join(out, script)))]))
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({version, code: hash(JSON.stringify(files)).slice(0, 16), files}))
}
