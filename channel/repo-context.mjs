// Which repo a session is in (ORR-1070), told to Claude as it starts: the folder's path, its `origin`, branch and
// default branch, and the project's `repo` as orrery has it. The hook adds it to a session's context on
// `SessionStart`, and the launcher to the system prompt of a session it starts, so it outlasts a `/clear`. Read on the
// machine, as orrery only knows a folder's name. A folder outside any git repo (the launcher's default folder, say)
// says there's no repo, so Claude doesn't go looking for one; a folder holding the project's repo one level down (a
// launcher serving several projects from the folder their repos sit in, ORR-1307) says where it is.
import {execFileSync} from 'node:child_process'
import {existsSync, readdirSync} from 'node:fs'
import {join, resolve} from 'node:path'

/** `git -C dir …`'s output, trimmed; none when it fails (no git, not a repo, no such ref). */
function git(dir, ...args) {
    try {
        return execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000}).trim() || undefined
    } catch {
        return undefined
    }
}

/** What git says about the repo `dir` is in; none when it's in none. */
export function repoOf(dir) {
    const path = git(dir, 'rev-parse', '--show-toplevel')
    if (!path) return undefined
    const head = git(dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
    return {
        path,
        origin: git(dir, 'remote', 'get-url', 'origin'),
        branch: git(dir, 'branch', '--show-current'),
        commit: git(dir, 'rev-parse', '--short', 'HEAD'),
        base: head?.replace(/^origin\//, ''),
    }
}

/** `owner/name` of a GitHub address in any of its forms (https, ssh, `.git` or not); none for another host. */
export function githubName(address) {
    const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(address ?? '').trim())
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined
}

/** The git repos directly inside `dir` whose origin is the GitHub repo `address`: where the project is checked out
 * when a session starts in the folder its repos sit in (ORR-1307). Only folders with a `.git` of their own are asked. */
export function checkoutsIn(dir, address, read = repoOf) {
    const wanted = githubName(address)
    if (!wanted) return []
    let entries
    try {
        entries = readdirSync(dir, {withFileTypes: true})
    } catch {
        return []
    }
    return entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(dir, entry.name, '.git')))
        .map(entry => join(dir, entry.name))
        .filter(path => githubName(read(path)?.origin) === wanted)
}

/** The lines telling Claude where it is: for `dir`, on `project`, whose `repo` orrery has (or none). `repo` is the
 * repo as `repoOf` reads it, passed in by tests. */
export function repoContext(dir, {project, repo: address, read = repoOf, below = checkoutsIn} = {}) {
    const folder = resolve(dir || process.cwd())
    const repo = read(folder)
    const named = address ? `Project "${project}"'s repo in orrery is ${address}` : project ? `Project "${project}" names no repo in orrery` : ''
    if (!repo) {
        const checkouts = address ? below(folder, address, read) : []
        if (checkouts.length) {
            return [
                `orrery: this session's folder, ${folder}, isn't itself a git repo, but holds the project's.`,
                `${named}, checked out at ${checkouts.join(', ')}. Work in ${checkouts.length === 1 ? 'that checkout' : 'one of those'} (or a worktree of it), not in this folder.`,
            ].join('\n')
        }
        return [
            `orrery: this session's folder, ${folder}, isn't in a git repo. There's no repo to work in here; don't look for one.`,
            ...address ? [`${named}, and it isn't checked out in this folder.`] : [],
        ].join('\n')
    }
    const differs = address && repo.origin && githubName(address) && githubName(address) !== githubName(repo.origin)
    return [
        `orrery: this session is in the git repo at ${repo.path}${repo.path === folder ? '' : ` (the folder is ${folder})`}.`,
        `- origin: ${repo.origin ?? 'none'}`,
        `- branch: ${repo.branch ?? `none (detached at ${repo.commit ?? 'no commit'})`}`,
        `- default branch: ${repo.base ?? 'not known (origin/HEAD isn\'t set)'}`,
        ...named ? [`- ${named[0].toLowerCase()}${named.slice(1)}${differs ? ": not this folder's origin, so check which repo the work belongs in" : ''}`] : [],
    ].join('\n')
}
