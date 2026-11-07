// The Claude Code adapter (ORR-1074): everything the launcher does that is particular to Claude Code, so another agent's
// adapter can sit beside it (agents.mjs says what an adapter is). It never runs tmux itself: the launcher hands it the
// session's pane, which it reads and types into.
import {execFileSync} from 'node:child_process'
import {chatOnly, lockedDown, modelArgs, resumeArgs} from './locked-down.mjs'
import {onYes} from './permission-prompt.mjs'
import {contextOf, contextWindow, modelOf} from './transcript.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** @type {import('./agents.mjs').Agent} */
export const claude = {
    name: 'claude',

    problem() {
        try {
            execFileSync('claude', ['--version'], {stdio: 'ignore'})
            return null
        } catch {
            return 'claude isn\'t on your PATH: install Claude Code, then run this again from the same shell'
        }
    },

    // It locks an untrusted launch down with no Bash, starts a chat as `chatOnly` says, starts a session on the model and
    // effort asked for, and takes a chat's Claude session up again (ORR-884): orrery gives each only to a launcher that does.
    claims: 'untrusted=no-bash&chat=yes&model=yes&resume=yes',

    // What it's told as it starts (`told`, the repo it's in: ORR-1070) goes in its system prompt, so a `/clear` keeps it.
    command({dir, server, launch, mode, told}) {
        return ['claude', '--dangerously-load-development-channels', `server:${server}`,
            ...launch.untrusted ? lockedDown(dir, server) : launch.chat ? chatOnly(dir, server) : ['--permission-mode', mode],
            ...modelArgs(launch), ...resumeArgs(launch), ...told ? ['--append-system-prompt', told] : []]
    },

    // Claude Code's startup prompts: the channel flag's warning it accepts; a folder not yet trusted it won't answer for
    // the owner, so the session is stopped and the owner told.
    async getPast(pane, {dir}) {
        for (let tries = 0; tries < 60; tries++) {
            await wait(500)
            const screen = pane.read()
            if (/trust (the files in )?this folder/i.test(screen)) return {stop: `the folder isn't trusted yet: run claude in ${dir} once by hand and accept it`}
            if (screen.includes('Loading development channels') && screen.includes('I am using this for local development')) {
                pane.press('Enter')
                return {}
            }
        }
        return {stuck: "didn't see the channel's warning"}
    },

    // Only while the pane still shows a permission prompt with the cursor on a plain "Yes" (ORR-489, ORR-750), so a late
    // Allow or Deny can't answer another prompt.
    allow(pane) {
        if (!onYes(pane.read())) return false
        pane.press('Enter')
        return true
    },

    deny(pane) {
        if (!onYes(pane.read())) return false
        pane.press('Escape')
        return true
    },

    // Context, from its hook: the tokens the latest reply in its transcript was given (input, cache read and cache
    // written), against the window Claude Code's table of models gives its model.
    context(hook) {
        const tokens = contextOf(hook)
        return tokens === undefined ? undefined : {tokens, window: contextWindow(modelOf(hook), tokens)}
    },

    window: contextWindow,

    // `/clear`, typed: its channel stays, and its hooks hand the new context what's left to do.
    async clear(pane) {
        pane.type('/clear')
        await wait(300)
        pane.press('Enter')
    },
}
