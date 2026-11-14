// Which repo a session is in (ORR-1070), told to Claude as it starts: the folder's path, its `origin`, branch and
// default branch, and the project's `repo` as orrery has it. The hook adds it to a session's context on
// `SessionStart`, and the launcher to the system prompt of a session it starts, so it outlasts a `/clear`. Read on the
// machine, as orrery only knows a folder's name. A folder outside any git repo (the launcher's default folder, say)
// says there's no repo, so Claude doesn't go looking for one.
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'

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

/** The lines telling Claude where it is: for `dir`, on `project`, whose `repo` orrery has (or none). `repo` is the
 * repo as `repoOf` reads it, passed in by tests. */
export function repoContext(dir, {project, repo: address, read = repoOf} = {}) {
    const folder = resolve(dir || process.cwd())
    const repo = read(folder)
    const named = address ? `Project "${project}"'s repo in orrery is ${address}` : project ? `Project "${project}" names no repo in orrery` : ''
    if (!repo) {
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
