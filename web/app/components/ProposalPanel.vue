<script setup lang="ts">
import type {Choice, Decision, Issue, Picks} from '#shared/roadmap'

// A proposal's decision, as the owner: approve it, ask for changes or reject it, with a note the session
// on it hears as their comment. Approved, it's still not work until it's committed to the roadmap. With
// choices, approving sends what's ticked, and Explore on an option asks for changes down that option.
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
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
// What's ticked: the decision's picks once there is one, over the agent's recommendation (which fills a
// choice the decision didn't reach, so one an option reveals shows what approving would send). Each source
// is watched on its own, by value: a new issue object from a live update leaves the owner's ticks alone.
const picks = ref<Picks>({})
watch([() => props.issue.id, () => JSON.stringify(props.issue.choices), () => JSON.stringify(props.issue.picks)], () => {
    picks.value = {...Object.fromEntries(props.issue.choices.map(c => [c.key, c.recommended])), ...props.issue.picks}
}, {immediate: true})
// Decided (approved, changes asked for, rejected), it shows as a summary: what was decided and picked,
// with Change decision to bring the controls back. Waiting on the owner, it's all there.
const reopened = ref(false)
watch([() => props.issue.id, () => props.issue.proposal, () => props.issue.decided_at], () => reopened.value = false)
const deciding = computed(() => props.issue.proposal === 'pending' || reopened.value)
/** What was picked, as the lines the summary shows: the question, then the options' titles. */
const picked = computed(() => props.issue.picks ? props.issue.choices.filter(c => props.issue.picks![c.key]).map(c => ({
    key: c.key, question: c.question, titles: c.options.filter(o => props.issue.picks![c.key]!.includes(o.key)).map(o => o.title),
})) : [])
const explored = computed(() => {
    const {explore, choices} = props.issue
    const choice = explore && choices.find(c => c.key === explore.choice)
    return choice ? {choice, option: choice.options.find(o => o.key === explore.option)} : null
})

const withNote = () => note.value.trim() ? {note: note.value.trim()} : {}
const decide = (decision: Decision) => send('/decide', 'POST', {decision, ...decision === 'approved' && props.issue.choices.length ? {picks: picks.value} : {}, ...withNote()})
const explore = (choice: Choice, option: string) => send('/decide', 'POST', {decision: 'changes', explore: {choice: choice.key, option}, ...withNote()})
const commit = () => send('', 'PATCH', {proposal: null})
</script>

<template>
  <section v-if="issue.proposal" class="flex flex-col gap-3 rounded-xl bg-well p-4 ring-1 ring-line">
    <header class="flex flex-wrap items-center gap-2">
      <StatusIcon column="proposed" />
      <h2 class="text-[13px] font-semibold text-fg">Proposal</h2>
      <span class="rounded-full px-2 py-px text-[11px] font-medium ring-1" :class="STATE[issue.proposal].chip">{{ STATE[issue.proposal].label }}</span>
      <span v-if="issue.decided_by && issue.decided_at && issue.proposal !== 'pending'" class="text-xs text-faint">
        {{ who(issue.decided_by) }} {{ DID[issue.proposal] }} · <span :title="issue.decided_at">{{ ago(issue.decided_at) }}</span>
      </span>
    </header>
    <p v-if="issue.decision_note && issue.proposal !== 'pending'" class="text-[13px] leading-relaxed text-muted">“{{ issue.decision_note }}”</p>
    <p v-if="explored && issue.proposal === 'changes'" class="text-[13px] text-muted">
      You asked to explore <span class="font-mono text-xs">{{ explored.option?.key }}</span> {{ explored.option?.title }}: the agent adds a choice down it, then puts it up again.
    </p>
    <ul v-if="!deciding && picked.length" class="flex flex-col gap-1 text-[13px]">
      <li v-for="p in picked" :key="p.key" class="text-muted">{{ p.question }} → <span class="font-medium text-fg">{{ p.titles.join(', ') || 'none' }}</span></li>
    </ul>
    <ProposalChoices v-if="deciding && issue.choices.length" v-model="picks" :issue="issue" @explore="explore" />
    <p class="text-xs text-muted">
      It's a proposal, not work yet: it sits in Proposed, out of the progress.
      <template v-if="issue.proposal === 'approved'">Commit it to put it on the roadmap.</template>
    </p>
    <template v-if="deciding">
      <textarea
          v-model="note"
          rows="2"
          :placeholder="issue.choices.length ? 'A note with your decision (optional): why, or what to look at when exploring' : 'A note with your decision (optional): what to change, or why'"
          aria-label="A note with your decision"
          class="min-h-14 resize-y rounded-lg bg-panel px-2.5 py-2 text-[13px] leading-relaxed text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
      />
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="h-8 rounded-lg bg-emerald-600 px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="busy" @click="decide('approved')">Approve</button>
        <button type="button" class="h-8 rounded-lg px-3 text-[13px] text-fg ring-1 ring-line hover:bg-hover disabled:opacity-40" :disabled="busy" @click="decide('changes')">Request changes</button>
        <button type="button" class="h-8 rounded-lg px-3 text-[13px] text-rose-600 ring-1 ring-rose-500/40 hover:bg-rose-500/10 disabled:opacity-40 dark:text-rose-400" :disabled="busy" @click="decide('rejected')">Reject</button>
        <button v-if="reopened" type="button" class="h-8 rounded-lg px-2 text-[13px] text-faint hover:text-fg" @click="reopened = false">Cancel</button>
      </div>
    </template>
    <div v-else class="flex flex-wrap items-center gap-2">
      <button v-if="issue.proposal === 'approved'" type="button" class="h-8 rounded-lg bg-accent-500 px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="busy" title="Make it work: it leaves Proposed for its column" @click="commit">Commit to the roadmap</button>
      <button type="button" class="h-8 rounded-lg px-2 text-[13px] text-faint hover:text-fg" @click="reopened = true">Change decision</button>
    </div>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </section>
</template>
