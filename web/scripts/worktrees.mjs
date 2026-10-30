// `pnpm worktrees`: the git worktrees sessions left behind (ORR-648), which it's safe to remove and why the rest stay.
// It only lists them; `pnpm worktrees --remove` removes those, through `git worktree remove`, which refuses anything
// dirty, and prunes the entries whose folders are gone. A local branch stays, so its commits can still be reached.
import {execFileSync} from 'node:child_process'
import {existsSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

/** How recently a worktree was touched for it to count as in use. */
export const IN_USE_FOR = 24 * 3600_000

/** What stays, however it looks: the playground's own checkout. */
const KEPT = /(^|\/)orrery-playground$/

/** Why a worktree stays, in a few words; none when it's safe to remove. A commit counts as safe only on GitHub: on a
 * remote branch, or the head of a merged PR, as a squash merge leaves it on neither `main` nor a branch that's kept. */
export function whyKept({path, locked, dirty, inUse, touched, onGitHub}, now = Date.now()) {
    if (KEPT.test(path)) return 'the playground'
    if (locked) return 'locked'
    if (dirty) return 'uncommitted changes'
    if (inUse) return 'a process is running from it'
    if (now - touched < IN_USE_FOR) return 'touched in the last 24h'
    if (!onGitHub) return 'commits not on GitHub'
    return null
}

/** `git worktree list --porcelain` as `{path, locked}`, the main checkout first. */
export function parseWorktrees(listed) {
    return listed.trim().split('\n\n').map(block => {
        const lines = block.split('\n')
        return {path: lines[0].slice('worktree '.length), locked: lines.some(line => line.startsWith('locked'))}
    })
}

const run = (command, ...args) => {
    try {
        return execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
    } catch {
        return ''
    }
}

function main(remove) {
    const git = (dir, ...args) => run('git', '-C', dir, ...args).trim()
    const root = process.cwd()
    git(root, 'fetch', '-q', 'origin')
    // None read (no `gh`, or offline): fewer count as on GitHub, so fewer go.
    const merged = new Set(run('gh', 'pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefOid,state', '--jq', '.[]|select(.state=="MERGED")|.headRefOid').split('\n'))
    const cwds = run('lsof', '-d', 'cwd', '-Fn').split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
    const commands = run('ps', '-axo', 'command')
    const [, ...worktrees] = parseWorktrees(git(root, 'worktree', 'list', '--porcelain'))
    const gone = worktrees.filter(w => !existsSync(w.path))
    const go = []
    const kept = new Map()
    for (const {path, locked} of worktrees.filter(w => existsSync(w.path))) {
        const gitDir = git(path, 'rev-parse', '--absolute-git-dir')
        const head = git(path, 'rev-parse', 'HEAD')
        const why = whyKept({
            path, locked,
            dirty: !!git(path, 'status', '--porcelain'),
            inUse: cwds.some(cwd => cwd === path || cwd.startsWith(`${path}/`)) || commands.includes(`${path}/`) || commands.includes(`${path} `),
            touched: Math.max(statSync(path).mtimeMs, ...['index', 'HEAD', 'logs/HEAD'].map(file => join(gitDir, file)).filter(existsSync).map(file => statSync(file).mtimeMs)),
            onGitHub: merged.has(head) || !!git(path, 'branch', '-r', '--contains', head),
        })
        if (why) kept.set(why, [...kept.get(why) ?? [], path])
        else go.push(path)
    }
    for (const [why, paths] of kept) console.log(`Keeps ${paths.length}, ${why}:\n${paths.map(path => `  ${path}`).join('\n')}`)
    if (!remove) {
        console.log(`Would remove ${go.length}:\n${go.map(path => `  ${path}`).join('\n')}`)
        console.log(`Would prune ${gone.length} whose folders are gone. pnpm worktrees --remove does both.`)
        return
    }
    let removed = 0
    for (const path of go) {
        run('git', '-C', root, 'worktree', 'remove', path)
        if (!existsSync(path)) removed++
        else console.log(`Couldn't remove ${path}`)
    }
    git(root, 'worktree', 'prune')
    console.log(`Removed ${removed}, and pruned ${gone.length} whose folders were gone.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.includes('--remove'))
