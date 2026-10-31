// A tmux for tests of the real launcher, first on PATH, which records its calls. It must never reach the real one, as a
// launcher adopts real sessions and kills them when it exits.
// Sessions and their options are a JSON file, so each call sees what the last one did, as with a tmux server.
export const FAKE_TMUX = `#!${process.execPath}
const fs = require('node:fs')
const dir = process.env.FAKE_TMUX
const args = process.argv.slice(2)
fs.appendFileSync(dir + '/calls', JSON.stringify(args) + '\\n')
const file = dir + '/state.json'
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const at = flag => args[args.indexOf(flag) + 1]
const session = () => state[at('-t')] ?? process.exit(1)
switch (args[0]) {
    case '-V': console.log('tmux 3.4-fake'); break
    case 'list-sessions': if (!Object.keys(state).length) process.exit(1); console.log(Object.keys(state).join('\\n')); break
    case 'new-session': state[at('-s')] = {}; save(); break
    case 'set-option': session()[args[3]] = args[4]; save(); break
    case 'show-options': { const value = session()[args[4]]; if (value === undefined) process.exit(1); console.log(value); break }
    case 'if-shell': {
        const [, option, owner] = /#\\{==:#\\{(.+?)\\},(.*)\\}$/.exec(args[4])
        if ((session()[option] ?? '') === owner) { const [, , , key, value] = args[5].split(' '); session()[key] = value; save() }
        break
    }
    case 'kill-session': session(); delete state[at('-t')]; save(); break
    case 'capture-pane': case 'send-keys': session(); break
    default: process.exit(1)
}
`
