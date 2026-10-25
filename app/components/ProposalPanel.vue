<script setup lang="ts">
import type {Decision, Issue} from '#shared/roadmap'

// A proposal's decision, as the owner: approve it, ask for changes or reject it, with a note the session
// on it hears as their comment. Approved, it's still not work until it's committed to the roadmap.
const props = defineProps<{project: string, issue: Issue}>()
const {who, load} = useOwner()
const note = ref('')
const busy = ref(false)
const failed = ref('')
watch(() => props.issue.id, () => {
    note.value = ''
    failed.value = ''
})

const STATE = {
    pending: {label: 'Waiting on your decision', chip: 'bg-amber-500/12 text-amber-700 ring-amber-500/30 dark:text-amber-300'},
    approved: {label: 'Approved', chip: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300'},
    changes: {label: 'Changes asked for', chip: 'bg-sky-500/12 text-sky-700 ring-sky-500/30 dark:text-sky-300'},
    rejected: {label: 'Rejected', chip: 'bg-rose-500/12 text-rose-700 ring-rose-500/30 dark:text-rose-300'},
}
const DID: Record<Decision, string> = {approved: 'approved it', changes: 'asked for changes', rejected: 'rejected it'}

const api = computed(() => `/api/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue.id)}`)

async function send(path: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`${api.value}${path}`, {method, headers: {'Orrery-Actor': await load()}, body})
        note.value = ''
    } catch (error) {
        failed.value = (error as {data?: {message?: string}}).data?.message ?? "Couldn't save it. Is Orrery running?"
    } finally {
        busy.value = false
    }
}
const decide = (decision: Decision) => send('/decide', 'POST', {decision, ...note.value.trim() ? {note: note.value.trim()} : {}})
const commit = () => send('', 'PATCH', {proposal: null})
</script>

<template>
  <section v-if="issue.proposal" class="flex flex-col gap-3 rounded-xl bg-well p-4 ring-1 ring-line">
    <header class="flex flex-wrap items-center gap-2">
      <StatusIcon column="proposed" />
      <h2 class="text-[13px] font-semibold text-fg">Proposal</h2>
      <span class="rounded-full px-2 py-px text-[11px] font-medium ring-1" :class="STATE[issue.proposal].chip">{{ STATE[issue.proposal].label }}</span>
      <span v-if="issue.decidedBy && issue.decidedAt && issue.proposal !== 'pending'" class="text-xs text-faint">
        {{ who(issue.decidedBy) }} {{ DID[issue.proposal] }} · <span :title="issue.decidedAt">{{ ago(issue.decidedAt) }}</span>
      </span>
    </header>
    <p v-if="issue.decisionNote && issue.proposal !== 'pending'" class="text-[13px] leading-relaxed text-muted">“{{ issue.decisionNote }}”</p>
    <p class="text-xs text-muted">
      It's a proposal, not work yet: it sits in Proposed, out of the progress.
      <template v-if="issue.proposal === 'approved'">Commit it to put it on the roadmap.</template>
    </p>
    <textarea
        v-model="note"
        rows="2"
        placeholder="A note with your decision (optional): what to change, or why"
        aria-label="A note with your decision"
        class="min-h-14 resize-y rounded-lg bg-panel px-2.5 py-2 text-[13px] leading-relaxed text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
    />
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="h-8 rounded-lg bg-emerald-600 px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="busy || issue.proposal === 'approved'" @click="decide('approved')">Approve</button>
      <button type="button" class="h-8 rounded-lg px-3 text-[13px] text-fg ring-1 ring-line hover:bg-hover disabled:opacity-40" :disabled="busy" @click="decide('changes')">Request changes</button>
      <button type="button" class="h-8 rounded-lg px-3 text-[13px] text-rose-600 ring-1 ring-rose-500/40 hover:bg-rose-500/10 disabled:opacity-40 dark:text-rose-400" :disabled="busy || issue.proposal === 'rejected'" @click="decide('rejected')">Reject</button>
      <button v-if="issue.proposal === 'approved'" type="button" class="ml-auto h-8 rounded-lg bg-accent-500 px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="busy" title="Make it work: it leaves Proposed for its column" @click="commit">Commit to the roadmap</button>
    </div>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </section>
</template>
