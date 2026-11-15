// Connects this machine to an orrery with login on, with no key to copy (ORR-1192). The install line asks
// `/api/settings` first: a 401 means the orrery wants a key this machine hasn't got (or has one it no longer takes). The
// line's own one-time code (`ORRERY_CODE`, put there by the signed-in page) is redeemed for one; without one, or with one
// that's used or ran out, the machine asks to connect: its person opens the page it prints, checks the words match, and
// presses Connect, while this waits for the answer. The agent key that comes back is kept where credentials.mjs finds it
// (keys.json, by the orrery's origin, mode 600), so the launcher, its sessions and the channel send it from then on.
import {spawn} from 'node:child_process'
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {dirname} from 'node:path'
import {authHeaders, keyFor, keysFile, originOf} from './credentials.mjs'

const POLL = 2000
const WAIT = 10 * 60_000

/** This machine's name, as its person sees it on the page: its host name, without the network's part (macOS's `.local`,
 * a home router's domain). */
export function machineName(host = hostname()) {
    return (host.trim().split('.')[0] || 'this machine').slice(0, 60)
}

/** Keeps `key` for the orrery at `url` in the keys file, in place of any it had there; the file stays its owner's alone. */
export function saveKey(url, key, {env = process.env, file = keysFile(env)} = {}) {
    let keys = {}
    try {
        keys = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`${file} can't be read as JSON, so the key wasn't kept: fix or move it, and run this again`)
    }
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error(`${file} isn't a list of keys by orrery, so the key wasn't kept: fix or move it, and run this again`)
    const origin = originOf(url)
    for (const server of Object.keys(keys)) if (originOf(server) === origin) delete keys[server]
    keys[origin] = key
    mkdirSync(dirname(file), {recursive: true, mode: 0o700})
    writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, {mode: 0o600})
    chmodSync(file, 0o600)
    return file
}

/** Opens `url` in the browser, if this machine has one to open; nothing happens when it can't. */
export function openPage(url, platform = process.platform) {
    const command = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null
    if (!command) return
    try {
        const child = spawn(command, [url], {detached: true, stdio: 'ignore'})
        child.on('error', () => {})
        child.unref()
    } catch {
        // No browser to open: the printed line is enough.
    }
}

const messageOf = async response => {
    try {
        return (await response.json())?.message
    } catch {
        return undefined
    }
}

/** The key an answer carries, only ever an agent key. */
const agentKey = (body, url) => {
    if (typeof body?.key !== 'string' || !body.key.startsWith('orrery_agent_')) throw new Error(`${url} answered with no agent key, so nothing was installed: run this again`)
    return {key: body.key, person: body.person}
}

/** The agent key the orrery at `url` gives this machine: for the line's code, else once its person presses Connect on
 * the page it prints. Throws, saying what to do, when neither comes. */
export async function connectMachine(url, {env = process.env, fetch = globalThis.fetch, say = console.log, open = openPage, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, name = machineName()} = {}) {
    const post = (path, body) => fetch(`${url}/api/machines/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
    })
    const unreachable = error => new Error(`couldn't reach ${url} to connect ${name} (${error.message}): run this again once it answers`)
    const code = env.ORRERY_CODE?.trim()
    if (code) {
        const response = await post('connect', {name, code}).catch(error => Promise.reject(unreachable(error)))
        if (response.status === 201) return agentKey(await response.json(), url)
        if (response.status !== 401 && response.status !== 404) {
            const message = await messageOf(response)
            throw new Error(`${url} couldn't connect ${name} with this line's code (${response.status}${message ? `: ${message}` : ''}), so nothing was installed: run this again`)
        }
        if (response.status === 401) say(`This line's code has been used or has run out, so ${name} asks to connect instead.`)
    }
    const response = await post('connect', {name}).catch(error => Promise.reject(unreachable(error)))
    if (response.status === 404) throw new Error(`${url} asks for a credential, and can't connect a machine itself: make an agent key on its page, and set ORRERY_KEY (or add it to ${keysFile(env)})`)
    if (response.status !== 201) {
        const message = await messageOf(response)
        throw new Error(`${url} wouldn't take ${name}'s request to connect (${response.status}${message ? `: ${message}` : ''}), so nothing was installed: run this again`)
    }
    const asked = await response.json()
    const words = Array.isArray(asked.words) ? asked.words.join(' ') : asked.words
    say(`To connect ${name}, open ${asked.url} and press Connect. Check it shows ${words}.`)
    open(asked.url)
    const until = Date.parse(asked.expires_at) || now() + WAIT
    while (now() < until) {
        await sleep(POLL)
        // A moment it can't reach the orrery isn't an answer: it asks again.
        const answer = await post('claim', {request: asked.request, secret: asked.secret}).catch(() => null)
        if (answer?.status === 201) return agentKey(await answer.json(), url)
        if (answer?.status === 410) throw new Error(`${name}'s request to connect was turned down or has run out, so nothing was installed: run this line again to ask again`)
    }
    throw new Error(`Nobody pressed Connect for ${name} before its request ran out, so nothing was installed: run this line again to ask again`)
}

const personName = person => typeof person === 'string' ? person : person?.name ?? person?.email ?? person?.id

/** Connects this machine to the orrery at `url` when it asks for a key this machine hasn't got, or no longer takes the
 * one it has, and keeps the key it gives. Whether it did: with login off, or a key that works, nothing changes. */
export async function connectIfAsked(url, {env = process.env, file = keysFile(env), fetch = globalThis.fetch, say = console.log, ...rest} = {}) {
    const status = await fetch(`${url}/api/settings`, {headers: authHeaders(url, {env, file}), signal: AbortSignal.timeout(10_000)}).then(r => r.status, () => 0)
    if (status !== 401) return false
    const name = rest.name ?? machineName()
    if (keyFor(url, {env, file})) say(`${url} no longer takes this machine's key, so ${name} connects again.`)
    const {key, person} = await connectMachine(url, {env, fetch, say, ...rest, name})
    const kept = saveKey(url, key, {env, file})
    // A key given on the line is sent before the file's: this run sends the new one.
    if (env.ORRERY_KEY?.trim()) env.ORRERY_KEY = key
    const who = personName(person)
    say(`Connected ${name} to ${url}${who ? ` as ${who}` : ''}. Its key is kept in ${kept}.`)
    return true
}
