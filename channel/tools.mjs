// The channel's tools: what a Claude session does with its project's roadmap, as MCP tools instead of
// curl. Each is one or two calls to Orrery's API as `claude`, with the session's id so the owner's comments
// on an issue it worked come back to it. They answer in short text a session reads at a glance (an issue
// in full as JSON), and a refused call comes back as an error with Orrery's reason.

const STATUS = {type: 'string', description: "A status's id (backlog, todo, in-progress, in-review, done, canceled, or one of the Orrery's own) or a kind (started, done…)"}
const PRIORITY = {type: ['string', 'null'], enum: ['P0', 'P1', 'P2', 'P3', null], description: 'P0 is urgent; null clears it'}
const CHOICES = {
    type: 'array',
    description: "A proposal's choices for the owner: questions answered by picking one option or any, your recommendation ticked",
    items: {
        type: 'object',
        required: ['key', 'question', 'options'],
        properties: {
            key: {type: 'string'},
            question: {type: 'string'},
            pick: {type: 'string', enum: ['one', 'any']},
            options: {type: 'array', items: {type: 'object', required: ['key', 'title'], properties: {key: {type: 'string'}, title: {type: 'string'}, body: {type: 'string'}}}},
            recommended: {type: 'array', items: {type: 'string'}},
            from: {type: 'object', properties: {choice: {type: 'string'}, option: {type: 'string'}}, description: 'Goes further down an earlier choice’s option'},
        },
    },
}
const FIELDS = {
    title: {type: 'string'},
    notes: {type: 'string', description: 'The description, in Markdown'},
    status: STATUS,
    priority: PRIORITY,
    labels: {type: 'array', items: {type: 'string'}},
    assignee: {type: ['string', 'null'], description: '"claude", or "owner" for the owner'},
    chunk: {type: ['string', 'null'], description: "A chunk's id (a number) or its old name"},
    parent: {type: ['string', 'null'], description: 'Makes it a sub-issue of this issue'},
    release: {type: ['string', 'null'], description: "The version of the release it ships in (see releases); null takes it out"},
    choices: CHOICES,
}

export const TOOLS = [
    {
        name: 'issues',
        description: "Lists the project's issues, sub-issues included, one line each: id, status, priority, assignee, title.",
        inputSchema: {type: 'object', properties: {
            status: STATUS,
            assignee: {type: 'string', description: 'A name, or "none"'},
            chunk: {type: 'string', description: 'A chunk id, or "none"'},
            release: {type: 'string', description: 'A release\'s version, or "none"'},
            label: {type: 'string'},
            q: {type: 'string', description: 'Text in the id or title'},
            open: {type: 'boolean', description: 'Only issues not done or canceled (default true)'},
        }},
    },
    {name: 'issue', description: 'An issue in full (description, status, sub-issues, proposal and choices) with its comments.', inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}}}},
    {
        name: 'create_issue',
        description: 'Adds an issue. With proposal: true it goes to the owner as a proposal (with choices, if you send them) instead of being work.',
        inputSchema: {type: 'object', required: ['title'], properties: {...FIELDS, proposal: {type: 'boolean'}}},
    },
    {
        name: 'update_issue',
        description: 'Changes an issue: any of its fields; proposal "pending" puts it (back) up to the owner, null commits an approved one.',
        inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}, ...FIELDS, proposal: {type: ['string', 'null'], enum: ['pending', null]}}},
    },
    {
        name: 'start_issue',
        description: 'Starts work on an issue: sets it in progress, assigns it to claude, and adds your comment if you give one.',
        inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}, comment: {type: 'string'}}},
    },
    {
        name: 'finish_issue',
        description: 'Closes an issue with a comment on what shipped: done by default, in-review when it waits on the owner, canceled (say why) when it won’t be done.',
        inputSchema: {type: 'object', required: ['id', 'comment'], properties: {id: {type: 'string'}, comment: {type: 'string'}, status: {type: 'string', enum: ['done', 'in-review', 'canceled']}}},
    },
    {
        name: 'comment',
        description: 'Comments on an issue (Markdown). asks: "decision" or "feedback" puts it at the top of the owner’s bell, and assigns the issue to them, until they answer.',
        inputSchema: {type: 'object', required: ['id', 'body'], properties: {id: {type: 'string'}, body: {type: 'string'}, asks: {type: 'string', enum: ['decision', 'feedback']}}},
    },
    {name: 'chunks', description: "Lists the project's chunks (milestones) with their status and progress.", inputSchema: {type: 'object', properties: {}}},
    {name: 'releases', description: "Lists the project's releases (those being prepared first), with their branch and how far the issues in each are.", inputSchema: {type: 'object', properties: {}}},
    {name: 'docs', description: "Lists the project's docs: decisions, how things work.", inputSchema: {type: 'object', properties: {}}},
    {name: 'doc', description: 'A doc in full.', inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}}}},
    {
        name: 'write_doc',
        description: 'Writes a doc, new or replacing the one with this id: a decision and why, how something works.',
        inputSchema: {type: 'object', required: ['id', 'title', 'body'], properties: {id: {type: 'string', description: 'lowercase-with-dashes'}, title: {type: 'string'}, body: {type: 'string', description: 'Markdown'}}},
    },
    {name: 'secrets', description: 'Lists the secrets you can use in egress, by name, with the hosts each may go to. You never see a value.', inputSchema: {type: 'object', properties: {}}},
    {
        name: 'egress',
        description: 'Calls an outside service with a secret: put {{secret:NAME}} in the url, a header or the body, and Orrery fills it in, sends it (https, only to a host the secret allows) and answers with the value scrubbed out. Every use is recorded.',
        inputSchema: {type: 'object', required: ['url'], properties: {
            url: {type: 'string'},
            method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']},
            headers: {type: 'object', additionalProperties: {type: 'string'}, description: 'e.g. {"Authorization": "Bearer {{secret:STRIPE_KEY}}"}'},
            body: {description: 'Text as it is; anything else goes as JSON'},
            issue: {type: 'string', description: 'The issue it is for, kept with the record'},
        }},
    },
]

/** The tools against one project's API (`api`, `…/api/projects/<project>`), writing as `claude` from `session`. */
export function orreryTools({api, session, fetch = globalThis.fetch}) {
    const headers = {'Content-Type': 'application/json', 'Orrery-Actor': 'claude', ...session ? {'Orrery-Session': session} : {}}
    // The project is the last part of `api`; secrets and egress are the Orrery's, at its root.
    const project = decodeURIComponent(api.split('/').pop())
    const root = api.replace(/\/projects\/[^/]+$/, '')
    async function call(method, path, body, base = api) {
        const response = await fetch(`${base}${path}`, {method, headers, ...body === undefined ? {} : {body: JSON.stringify(body)}})
        const text = await response.text()
        const data = text ? JSON.parse(text) : null
        if (!response.ok) throw new Error(data?.message ?? data?.statusMessage ?? `${response.status} ${response.statusText}`)
        return data
    }
    const issuePath = id => `/issues/${encodeURIComponent(id)}`
    const pick = (args, keys) => Object.fromEntries(keys.filter(k => args[k] !== undefined).map(k => [k, args[k]]))
    const line = i => `${i.id} [${[i.status, i.priority, i.assignee].filter(Boolean).join(', ')}] ${i.title}${i.proposal ? ` (proposal: ${i.proposal})` : ''}`

    const run = {
        async issues(args) {
            const query = new URLSearchParams(pick(args, ['status', 'assignee', 'chunk', 'release', 'label', 'q']))
            let issues = await call('GET', `/issues?${query}`)
            if (args.open !== false && !args.status) issues = issues.filter(i => !['done', 'canceled'].includes(i.kind))
            return issues.length ? issues.map(line).join('\n') : 'No issues match.'
        },
        async issue({id}) {
            const [issue, comments] = await Promise.all([call('GET', issuePath(id)), call('GET', `${issuePath(id)}/comments`)])
            const {tasks, counts, kinds, ...rest} = issue
            return JSON.stringify({...rest, subIssues: tasks.map(line), comments: comments.map(c => ({by: c.createdBy, at: c.createdAt, ...c.asks ? {asks: c.asks, answered: c.answered} : {}, body: c.body}))}, null, 1)
        },
        async create_issue(args) {
            const {proposal, ...fields} = args
            const issue = await call('POST', '/issues', {...fields, ...proposal ? {proposal: 'pending'} : {}})
            return `Made ${line(issue)}`
        },
        async update_issue({id, ...fields}) {
            return `Now ${line(await call('PATCH', issuePath(id), fields))}`
        },
        async start_issue({id, comment}) {
            const issue = await call('PATCH', issuePath(id), {status: 'started', assignee: 'claude'})
            if (comment) await call('POST', `${issuePath(id)}/comments`, {body: comment})
            return `Started ${line(issue)}`
        },
        async finish_issue({id, comment, status = 'done'}) {
            await call('POST', `${issuePath(id)}/comments`, {body: comment})
            return `${status === 'done' ? 'Done' : status === 'canceled' ? 'Canceled' : 'In review'}: ${line(await call('PATCH', issuePath(id), {status}))}`
        },
        async comment({id, body, asks}) {
            const posted = await call('POST', `${issuePath(id)}/comments`, {body, ...asks ? {asks} : {}})
            return `Commented on ${id} (comment ${posted.id})${asks ? `, asking the owner for ${asks === 'decision' ? 'a decision' : 'feedback'}` : ''}.`
        },
        async chunks() {
            const chunks = await call('GET', '/chunks')
            return chunks.map(c => `${c.id || 'none'} [${c.column}${c.priority ? `, ${c.priority}` : ''}] ${c.title}: ${c.kinds.done}/${c.kinds.backlog + c.kinds.todo + c.kinds.started + c.kinds.done} done`).join('\n') || 'No chunks yet.'
        },
        async releases() {
            const releases = await call('GET', '/releases')
            return releases.map(r => `${r.version}${r.shippedOn ? ` (shipped ${r.shippedOn})` : ''}${r.branch ? ` on ${r.branch}` : ''}: ${r.issues} issue${r.issues === 1 ? '' : 's'}, ${r.kinds.done}/${r.kinds.backlog + r.kinds.todo + r.kinds.started + r.kinds.done} done`).join('\n')
                || 'No releases yet.'
        },
        async docs() {
            const docs = await call('GET', '/docs')
            return docs.map(d => `${d.id}: ${d.title}`).join('\n') || 'No docs yet.'
        },
        async doc({id}) {
            const doc = await call('GET', `/docs/${encodeURIComponent(id)}`)
            return `# ${doc.title}\n\n${doc.body}`
        },
        async write_doc({id, title, body}) {
            await call('PUT', `/docs/${encodeURIComponent(id)}`, {title, body})
            return `Saved the doc ${id}.`
        },
        async secrets() {
            const secrets = await call('GET', '/secrets', undefined, root)
            return secrets.map(s => `${s.name} → ${s.hosts.join(', ')}${s.projects ? ` (only ${s.projects.join(', ')})` : ''}`).join('\n') || 'No secrets yet; the owner sets them on App settings.'
        },
        async egress(args) {
            const {status, headers, body, truncated} = await call('POST', '/egress', {...args, project}, root)
            return `${status}${headers['content-type'] ? ` (${headers['content-type']})` : ''}\n\n${body}${truncated ? '\n\n(cut at 1 MB)' : ''}`
        },
    }

    /** Runs a tool; an MCP result, an error result when Orrery refuses or can't be reached. */
    return async function callTool(name, args = {}) {
        if (!run[name]) return {isError: true, content: [{type: 'text', text: `No tool "${name}"`}]}
        try {
            return {content: [{type: 'text', text: await run[name](args)}]}
        } catch (error) {
            return {isError: true, content: [{type: 'text', text: `Orrery said no: ${error.message}`}]}
        }
    }
}
