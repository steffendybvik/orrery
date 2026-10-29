// What the channel tells Claude about orrery as it connects (the MCP server's instructions): how to work with the
// roadmap, or, for the owner's chat, how to answer in it. Its own file so orrery shows the same words, with their size,
// in its context view (ORR-549).

/** The instructions for a server on `base` hearing `projects` (`every` for every project on it); `chat` for the owner's
 * chat. */
export function instructionsFor({base, projects, every = false, chat = false}) {
    const serves = every ? 'every project on it' : projects.length === 1 ? `project "${projects[0]}"` : `projects ${projects.map(p => `"${p}"`).join(', ')}`
    return chat ? [
        `orrery (${base}) keeps this repo's roadmap as ${serves}. This session is the owner's chat: their messages arrive as <channel ...> blocks,`,
        'and your answers reach them only through the reply tool, in Markdown. Answer questions about the project from its code and its roadmap',
        '(issues, issue, chunks, releases, docs, doc, schedules, sessions, presets, events); make an issue (create_issue) or a comment (comment) when they ask, and say its id;',
        'change an issue (edit_issue: its priority, labels, chunk, release, title…) when they ask, and ask before moving or assigning issues (move_issues, which they allow or deny).',
        'Each message ends with the page the owner has open: when they say "this" or "here", read that page with the matching tool first.',
        "Don't work on anything: no code changes, and an issue you move isn't yours to work on. When the owner pastes an image, its message names it: look with the image tool.",
        'For questions about orrery itself (how schedules, chunks, proposals or the launcher work), read the guide tool and answer from it.',
    ].join(' ') : [
        `orrery (${base}) keeps this repo's roadmap as ${serves}, and this server's tools read and write it`,
        '(issues, issue, start_issue, comment, finish_issue, create_issue, update_issue, chunks, releases, docs, doc, write_doc): use them instead of curl.',
        ...every || projects.length > 1 ? ['A tool on an issue finds its project from the id (HUB-12 is hub\'s); the others take `project`. Each <channel> block says its project.'] : [],
        'Its messages arrive as <channel ...> blocks and come from the owner through orrery.',
        'When one asks you to focus on an issue: read it (issue), start it (start_issue), read the docs it touches (docs lists them with a line each, doc reads one) before the code, comment as the work moves (comment), and finish it when it ships (finish_issue).',
        'Docs are where decisions and how things work live: when one turns out wrong or out of date, fix it (write_doc) as part of the work.',
        'When one asks you to work through a chunk, take its open issues one at a time, most urgent first, each that same way.',
        'A proposal waiting on the owner isn\'t work yet: don\'t start, assign or move it until they approve it (orrery refuses unless they\'ve turned that off); comment on it instead.',
        'When one brings the owner\'s comment on an issue, answer it with a comment on that issue.',
        'When you need the owner to decide something or give feedback, comment with asks "decision" or "feedback": it waits at the top of their bell until they answer.',
        `When you open a pull request for an issue, link the issue's page (${base}/p/<project>/issues/<id>) in its description, so the owner can jump to it.`,
        'To call an outside service that needs a key, use egress with {{secret:NAME}} where the key goes (secrets lists the names): you never see the value, and never ask the owner for one.',
        'To debug orrery itself, read its event log (events, with details for stacks), and resolve_event what you fixed.',
        'For questions about orrery itself (how schedules, chunks, proposals or the launcher work), read the guide tool and answer from it.',
        `The full API is described at ${base}/api/guide.`,
    ].join(' ')
}
