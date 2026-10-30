// What a session is told of a signal on one of its projects (ORR-702, out of the channel so a budget can hold it): the
// owner's template, filled in, when the signal has one, else these. An older orrery's focus comes with none. `api` is the
// project's address, and `chat` says it's the owner's chat, which hears only their messages.
export function signalWords(signal, {api, chat = false}) {
    const where = [signal.column, signal.priority, signal.chunk].filter(Boolean).join(', ')
    const issue = `${api}/issues/${encodeURIComponent(signal.issue)}`
    // A focus comes with what to say (the owner's template, filled in); an older orrery's doesn't.
    return chat
        ? [
            `${signal.created_by}, in the chat:`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            'Answer with the reply tool.',
        ].join('\n')
        : signal.prompt
        ? signal.prompt
        : signal.kind === 'message' && !signal.schedule
        ? [
            `${signal.created_by} sends you a message, to you alone:`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            'Answer or act on it as it asks. If it turns into work worth tracking, put it in an issue as usual.',
        ].join('\n')
        : signal.kind === 'message'
        ? [
            `${signal.created_by}'s schedule "${signal.title}" says:`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            'Do what it says. If it turns into work worth tracking, put it in an issue as usual.',
        ].join('\n')
        : !signal.issue
        ? [
            `${signal.created_by} asks you to work through ${signal.status ? `the ${signal.status} issues in ` : ''}chunk ${signal.chunk}: ${signal.title} [${[signal.column, signal.priority].filter(Boolean).join(', ')}].`,
            signal.note ? `Note: ${signal.note}` : '',
            signal.issues.length
                ? `Its ${signal.status ?? 'open'} issues, most urgent first:\n${signal.issues.map(i => `- ${i.id}: ${i.title} [${[i.column, i.priority].filter(Boolean).join(', ')}]`).join('\n')}`
                : `It has no ${signal.status ?? 'open'} issues left.`,
            `Take them one at a time as you would a focus on each (in-progress, comments, done). Read ${signal.chunk === 'none' ? `them with: curl '${api}/issues?chunk=none'` : `the chunk with: curl ${api}/chunks/${encodeURIComponent(signal.chunk)}`}`,
        ].filter(Boolean).join('\n')
        : signal.kind === 'comment'
        ? [
            `${signal.created_by} commented on ${signal.issue} (${signal.title}):`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            `Answer with a comment on it: curl -s -X POST ${issue}/comments -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' --data @reply.json`,
            `(the whole thread: curl ${issue}/comments)`,
        ].join('\n')
        : [
            `${signal.created_by} asks you to focus on ${signal.issue}: ${signal.title}${where ? ` [${where}]` : ''}.`,
            signal.note ? `Note: ${signal.note}` : '',
            `Read it with: curl ${issue}`,
        ].filter(Boolean).join('\n')
}
