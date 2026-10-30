<script setup lang="ts">
import type {Decision, Issue} from '#shared/roadmap'
import {isFrozen, linkRef} from '#shared/roadmap'

// The issues ticked on the page (useSelection), changed at once: decided when they're all proposals waiting on the
// owner, else set (status, priority, assignee, labels added or taken off, and chunk or release within one project),
// or deleted, or chained in order (each waiting on the one above it). Under the buttons it says how to tick more.
// Each project's ticked issues go in one call, and each issue on its own: what was refused is listed.
const route = useRoute()
const {byId} = useRoadmaps()
const {who, name: owner} = useOwner()
const {selected, key, byProject, inPageOrder, clear} = useSelection()
const {places} = useStatuses()

watch(() => route.path, () => clear())

/** The ticked issues the page knows, with their project. */
const issues = computed(() => [...byProject.value].flatMap(([project, ids]) => {
    const p = byId(project)
    return p ? ids.map(id => findIssue(p, id)?.issue).filter((i): i is Issue => !!i).map(issue => ({project: p, issue})) : []
}))
const one = computed(() => byProject.value.size === 1 ? byId([...byProject.value.keys()][0]) : undefined)
const proposals = computed(() => issues.value.length > 0 && issues.value.every(({issue}) => issue.proposal === 'pending'))

const busy = ref(false)
const said = ref('')
const failed = ref<string[]>([])
const note = ref('')
const confirming = ref(false)
// Cleared (Esc, Clear), the last batch's outcome goes too; a batch's own reticking leaves it.
watch(selected, now => {
    confirming.value = false
    if (!now.length && !busy.value) {
        said.value = ''
        failed.value = []
    }
}, {flush: 'sync'})

/** Sends one call per project, then says how it went and keeps only the refused ones ticked. */
async function run(method: 'PATCH' | 'POST' | 'DELETE', path: string, body: Record<string, unknown>, verb: string) {
    busy.value = true
    said.value = ''
    failed.value = []
    const refused: string[] = []
    const why: string[] = []
    let done = 0
    for (const [project, ids] of byProject.value) {
        try {
            const results = await apiFetch<{id: string, ok: boolean, error?: string}[]>(`/projects/${encodeURIComponent(project)}/issues${path}`, {method, body: {ids, ...body}})
            for (const r of results) {
                if (r.ok) done++
                else {
                    refused.push(`${project}/${r.id}`)
                    why.push(`${r.id}: ${r.error}`)
                }
            }
        } catch (error) {
            refused.push(...ids.map(id => `${project}/${id}`))
            why.push(`${project}: ${errorMessage(error)}`)
        }
    }
    note.value = ''
    selected.value = refused
    said.value = `${verb} ${done} ${done === 1 ? 'issue' : 'issues'}${refused.length ? `; ${refused.length} skipped` : ''}`
    failed.value = why
    busy.value = false
    if (!refused.length) setTimeout(() => said.value = '', 3000)
}

const set = (change: Record<string, unknown>, verb = 'Changed') => run('PATCH', '', {set: change}, verb)
const decide = (decision: Decision) => run('POST', '/decide', {decision, ...note.value.trim() ? {note: note.value.trim()} : {}}, {approved: 'Approved', changes: 'Asked for changes on', rejected: 'Rejected'}[decision])
const remove = () => run('DELETE', '', {}, 'Deleted')

// Chain in order (ORR-601): each ticked issue, top to bottom as the page lists them, comes to depend on the one above
// it as well as what it did. One call each, in order; any refused (one that would close a loop, say) is listed, and
// stays ticked with the one it was to wait on.
async function chain() {
    const byKey = new Map(issues.value.map(i => [key(i.project.id, i.issue.id), i]))
    const order = inPageOrder().flatMap(k => byKey.get(k) ?? [])
    busy.value = true
    said.value = ''
    failed.value = []
    const refused: string[] = []
    const why: string[] = []
    for (const [at, {project, issue}] of order.entries()) {
        const above = order[at - 1]
        if (!above) continue
        const link = linkRef(project.id, above.project.id, above.issue.id)
        const now = issue.depends_on ?? []
        if (now.includes(link)) continue
        try {
            await apiFetch(`/projects/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(issue.id)}`, {method: 'PATCH', body: {depends_on: [...now, link]}})
        } catch (error) {
            refused.push(key(above.project.id, above.issue.id), key(project.id, issue.id))
            why.push(`${issue.id}: ${errorMessage(error)}`)
        }
    }
    selected.value = [...new Set(refused)]
    said.value = why.length ? `Chained ${order.length - 1 - why.length} of ${order.length - 1} links` : `Chained ${order.length} issues`
    failed.value = why
    busy.value = false
    if (!why.length) setTimeout(() => said.value = '', 3000)
}

// Each picker sets one thing on every ticked issue; its own value is none of its options, so none shows ticked.
const pick = (apply: (value: string) => void) => computed({get: () => '\u0000', set: apply})
const status = pick(value => set({status: value}))
const priority = pick(value => set({priority: value || null}))
const assignee = pick(value => set({assignee: value.trim() || null}))
const chunk = pick(value => set({chunk: value || null}))
const release = pick(value => set({release: value || null}))
const addLabel = pick(value => run('PATCH', '', {labels: {add: [value]}}, 'Labelled'))
const removeLabel = pick(value => run('PATCH', '', {labels: {remove: [value]}}, 'Took the label off'))

const statusOptions = computed(() => places.value.filter(p => p.id !== 'proposed').map(p => ({value: p.id, label: p.label})))
const assigneeOptions = computed(() => {
    const people = new Set([owner.value, 'claude', ...issues.value.flatMap(({project}) => allIssues(project).map(({issue}) => issue.assignee))].filter((n): n is string => !!n))
    return [{value: '', label: 'Unassigned'}, ...[...people].map(p => ({value: p, label: who(p)}))]
})
const labelsKnown = computed(() => [...new Set(issues.value.flatMap(({project}) => allIssues(project).flatMap(({issue}) => issue.labels)))].sort().map(l => ({value: l, label: l})))
const labelsOn = computed(() => [...new Set(issues.value.flatMap(({issue}) => issue.labels))].sort().map(l => ({value: l, label: l})))
const chunks = computed(() => one.value ? chunkOptions(one.value.board.chunks) : [])
const releaseOptions = computed(() => one.value?.releases.length ? [{value: '', label: 'No release'}, ...one.value.releases.map(r => ({value: r.version, label: isFrozen(r) ? `${r.version} · frozen` : r.version}))] : [])
const button = 'flex h-7 items-center whitespace-nowrap rounded-md px-2 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg'
</script>

<template>
  <div v-if="selected.length || said" class="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
    <div class="glass pointer-events-auto flex max-w-full flex-col gap-2 rounded-2xl px-3 py-2 shadow-lg" role="toolbar" aria-label="Change the ticked issues">
      <div v-if="selected.length" class="flex flex-wrap items-center gap-2">
        <span class="text-[13px] font-medium text-fg">{{ selected.length }} selected</span>
        <UiButton variant="ghost" size="xs" title="Clear (Esc)" @click="clear">Clear <KeyHint>esc</KeyHint></UiButton>
        <span class="mx-1 h-5 w-px bg-line" />
        <template v-if="proposals">
          <input v-model="note" aria-label="A note with your decision" placeholder="A note for all of them (optional)" class="h-7 w-56 rounded-md bg-well px-2 text-xs text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
          <UiButton variant="success" :disabled="busy" title="Each takes its recommended picks; one with none is skipped" @click="decide('approved')">Approve</UiButton>
          <UiButton :disabled="busy" @click="decide('changes')">Request changes</UiButton>
          <UiButton variant="danger-outline" :disabled="busy" @click="decide('rejected')">Reject</UiButton>
        </template>
        <template v-else>
          <PropertyPicker v-model="status" :options="statusOptions" label="Status" up :disabled="busy"><span :class="button">Status</span></PropertyPicker>
          <PropertyPicker v-model="priority" :options="PRIORITY_OPTIONS" label="Priority" up :disabled="busy"><span :class="button">Priority</span></PropertyPicker>
          <PropertyPicker v-model="assignee" :options="assigneeOptions" label="Assignee" placeholder="Find or assign someone…" creatable create-verb="Assign" up :disabled="busy"><span :class="button">Assignee</span></PropertyPicker>
          <PropertyPicker v-model="addLabel" :options="labelsKnown" label="Add a label" placeholder="Find or add a label…" creatable up :disabled="busy"><span :class="button">+ Label</span></PropertyPicker>
          <PropertyPicker v-if="labelsOn.length" v-model="removeLabel" :options="labelsOn" label="Take a label off" up :disabled="busy"><span :class="button">− Label</span></PropertyPicker>
          <PropertyPicker v-if="one" v-model="chunk" :options="chunks" label="Chunk" up :disabled="busy"><span :class="button">Chunk</span></PropertyPicker>
          <PropertyPicker v-if="releaseOptions.length" v-model="release" :options="releaseOptions" label="Release" up :disabled="busy"><span :class="button">Release</span></PropertyPicker>
          <button v-if="issues.length > 1" type="button" :class="[button, 'disabled:opacity-60']" :disabled="busy" title="Each waits on the one above it, top to bottom" @click="chain">Chain in order</button>
        </template>
        <template v-if="confirming">
          <UiButton variant="danger" :disabled="busy" @click="remove">Delete {{ selected.length }}, with their sub-issues</UiButton>
          <UiButton @click="confirming = false">Cancel</UiButton>
        </template>
        <UiButton v-else variant="danger-ghost" size="xs" square title="Delete them" aria-label="Delete them" @click="confirming = true">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
        </UiButton>
      </div>
      <p v-if="said" class="text-xs text-muted" role="status">{{ said }}</p>
      <p v-else-if="selected.length" class="hidden items-center gap-1 text-[11px] text-faint sm:flex">
        Drag over the ticks, or shift-click, for a run · a group's tick for all of it · <KeyHint>⌘A</KeyHint> for the page
      </p>
      <ul v-if="failed.length" class="max-h-24 overflow-y-auto text-xs text-rose-600 dark:text-rose-400">
        <li v-for="line in failed" :key="line">{{ line }}</li>
      </ul>
    </div>
  </div>
</template>
