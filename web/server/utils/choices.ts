// A proposal's choices: questions the owner answers by picking one option or any of them, the agent's
// recommendation ticked. Checked as they come in, resolved into the owner's picks when they approve, and
// put into words for the comment the session hears.
import type {Choice, Picks} from '#shared/roadmap'
import {liveChoices} from '#shared/roadmap'
import {isObject} from './input'

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/

const text = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} should be text`)
    return value.trim()
}

/** Checks a list of choices; gives it back as JSON. Keys are unique, each choice has two options or more,
 * the recommendation is among them (one at most for `pick: one`), and `from` names an earlier choice's option. */
export function parseChoices(value: unknown): string {
    if (!Array.isArray(value)) throw new Error('should be a list of {key, question, pick, options, recommended?, from?}')
    const choices: Choice[] = []
    for (const [i, raw] of value.entries()) {
        const at = `choice ${i + 1}`
        if (!isObject(raw)) throw new Error(`${at} should be an object`)
        const key = text(raw.key, `${at}'s "key"`)
        if (!KEY.test(key)) throw new Error(`${at}'s key "${key}" should be letters, digits, - or _`)
        if (choices.some(c => c.key === key)) throw new Error(`two choices have the key "${key}"`)
        const pick = raw.pick ?? 'one'
        if (pick !== 'one' && pick !== 'any') throw new Error(`${key}'s "pick" is "${String(pick)}", not one or any`)
        if (!Array.isArray(raw.options) || raw.options.length < 2) throw new Error(`${key} needs two options or more`)
        const options = raw.options.map((option: unknown, j: number) => {
            if (!isObject(option)) throw new Error(`${key}'s option ${j + 1} should be an object`)
            const body = option.body === undefined || option.body === null ? undefined : text(option.body, `${key}'s option ${j + 1} "body"`)
            return {key: text(option.key, `${key}'s option ${j + 1} "key"`), title: text(option.title, `${key}'s option ${j + 1} "title"`), ...body ? {body} : {}}
        })
        if (new Set(options.map(o => o.key)).size !== options.length) throw new Error(`${key} has two options with the same key`)
        const recommended = raw.recommended === undefined ? [] : raw.recommended
        if (!Array.isArray(recommended) || recommended.some(r => !options.some(o => o.key === r))) throw new Error(`${key}'s "recommended" should list its options' keys`)
        if (pick === 'one' && recommended.length > 1) throw new Error(`${key} is pick one, so it recommends one option at most`)
        let from: Choice['from']
        if (raw.from !== undefined && raw.from !== null) {
            const given = raw.from
            if (!isObject(given)) throw new Error(`${key}'s "from" should be {choice, option}`)
            const parent = choices.find(c => c.key === given.choice)
            if (!parent?.options.some(o => o.key === given.option)) throw new Error(`${key}'s "from" should name an option of a choice before it`)
            from = {choice: parent.key, option: String(given.option)}
        }
        choices.push({key, question: text(raw.question, `${key}'s "question"`), pick, options, recommended: recommended as string[], ...from ? {from} : {}})
    }
    return JSON.stringify(choices)
}

/** The owner's picks for approving: what they sent, else the recommendation, for every choice that counts.
 * Throws what's wrong: an unknown choice or option, two picks for a pick-one, or a choice with no pick. */
export function resolvePicks(choices: Choice[], sent: Picks): Picks {
    for (const key of Object.keys(sent)) {
        if (!choices.some(c => c.key === key)) throw new Error(`there's no choice "${key}"; the choices are ${choices.map(c => c.key).join(', ')}`)
    }
    const picks: Picks = {}
    for (const choice of choices) picks[choice.key] = sent[choice.key] ?? choice.recommended
    const resolved: Picks = {}
    for (const choice of liveChoices(choices, picks)) {
        const picked = picks[choice.key]!
        const unknown = picked.filter(p => !choice.options.some(o => o.key === p))
        if (unknown.length) throw new Error(`${choice.key} has no option ${unknown.join(', ')}`)
        if (choice.pick === 'one' && picked.length !== 1) throw new Error(`pick one option for ${choice.key} (${choice.question})`)
        resolved[choice.key] = [...new Set(picked)]
    }
    return resolved
}

/** The picks in words, one line per choice: the question, then what was picked, in bold; an option's key goes
 * with its title only when it's a label (`A`, `B2`), not a word that would just repeat it.
 * `- Which parts to build first? → **A** Write-only store, **B** Orrery makes the call` */
export function describePicks(choices: Choice[], picks: Picks): string {
    const label = (key: string) => /^[A-Z][0-9]?$/.test(key)
    return choices.filter(c => picks[c.key]).map(c => {
        const chosen = c.options.filter(o => picks[c.key]!.includes(o.key)).map(o => label(o.key) ? `**${o.key}** ${o.title}` : `**${o.title}**`)
        return `- ${c.question} → ${chosen.length ? chosen.join(', ') : 'none'}`
    }).join('\n')
}
