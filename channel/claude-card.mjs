// How a Claude Code session's card shows what it runs on (ORR-1074): the model as people say it, and its effort. The
// Claude adapter's, kept apart with no imports, as the web draws it (ModelChip.vue through agent-cards.mjs).

/** A model's id as people say it (ORR-871): `claude-opus-5-5` is Opus 5.5, `claude-sonnet-5-20260101` Sonnet 5, and a
 * 1M context (`[1m]`) says so. An id it can't read is shown as it is.
 * @param {string} id */
export function modelLabel(id) {
    const long = /\[1m\]$/i.test(id)
    const match = /^(?:anthropic\.)?claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:\[1m\])?$/i.exec(id.trim())
    if (!match) return id
    const [, family, major, minor] = match
    const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`
    return long ? `${name} · 1M` : name
}

/**
 * The chip a session's card shows (ORR-969). The model is the one its hook says it runs on (ORR-871), else the one orrery
 * started it on when it chose one (ORR-868): none for Claude Code's default (`best`). Its effort beside it (ORR-894): the
 * one its hook last said, else the one it was started at. `normal` (the Sessions page, the chat pane) names the model
 * and effort; `condensed` (the sessions panel, the sidebar) only the effort, or the model's family when no effort is
 * known. The title has the rest: started on, runs on now. No label means no chip.
 * @param {{model?: string, effort?: string, started?: {model?: string, effort?: string}}} session
 * @param {'normal' | 'condensed'} [size]
 * @returns {{label: string | undefined, title: string}}
 */
export function chip(session, size = 'normal') {
    const startedOn = session.started?.model
    const chosen = startedOn && startedOn !== 'best' && startedOn !== 'default' ? startedOn : undefined
    const id = session.model ?? chosen
    const model = id ? modelLabel(id) : undefined
    const startedAt = session.started?.effort
    const effort = session.effort ?? startedAt
    const label = size === 'condensed' ? effort ?? model?.split(' ')[0] : [model, effort].filter(Boolean).join(' · ') || undefined
    const started = chosen ? `started on ${chosen}${startedAt ? `, ${startedAt} effort` : ''}`
        : startedAt ? `started at ${startedAt} effort` : ''
    const now = [
        session.model && `runs on ${modelLabel(session.model)}`,
        session.effort && session.effort !== startedAt && `at ${session.effort} effort`,
    ].filter(Boolean).join(', ')
    const text = [started, now].filter(Boolean).join(' · ')
    return {label, title: text.charAt(0).toUpperCase() + text.slice(1)}
}

export const claudeCard = {name: 'claude', modelLabel, chip}
