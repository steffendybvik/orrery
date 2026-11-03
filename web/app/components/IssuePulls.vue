<script setup lang="ts">
import type {IssuePulls, PullRequest, Signal} from '#shared/roadmap'
import {sendBackNote} from '#shared/roadmap'

// On an issue's page: its open pull requests on the project's GitHub repo, and where each stands, so an issue in
// review or done isn't taken as shipped while its PR waits (ORR-485), then those merged or closed, so it can say what
// shipped for it and where it went (ORR-795). Asked again every minute while the page is
// open, and when the issue changes; orrery keeps GitHub's answer a minute (five without a token), so this is cheap.
// Nothing shows for an issue without a PR. A PR that conflicts, is behind
// or fails its checks has **Send back**: a focus on the issue saying what the PR needs, to the session on it (or one
// orrery picks, or starts when nobody's listening), as the owner's (ORR-492).
const props = defineProps<{project: string, issue: string, updated?: string}>()

const {load: owner} = useOwner()
const got = ref<IssuePulls>()
const key = computed(() => `${props.project}/${props.issue}`)
async function load() {
    const at = key.value
    // Naming the owner: anyone else gets a PR without its title or branch (ORR-532).
    const answer = await owner()
        .then(actor => apiFetch<IssuePulls>(`/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/pulls`, {headers: {'Orrery-Actor': actor}}))
        .catch(() => undefined)
    if (answer && at === key.value) got.value = answer
}
const total = computed(() => (got.value?.pulls.length ?? 0) + (got.value?.done?.length ?? 0))
watch(key, () => got.value = undefined)
watch(() => `${key.value}@${props.updated}`, load, {immediate: true})
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => timer = setInterval(() => {
    if (document.visibilityState === 'visible') void load()
}, 60_000))
onBeforeUnmount(() => clearInterval(timer))

/** Per PR: sending, sent, or why it couldn't. */
const sent = ref<Record<number, {busy?: boolean, sent?: boolean, failed?: string}>>({})
watch(key, () => sent.value = {})
async function sendBack(pull: PullRequest) {
    const note = sendBackNote(pull)
    if (!note) return
    sent.value = {...sent.value, [pull.number]: {busy: true}}
    try {
        await apiFetch<{signal: Signal}>(`/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/focus`, {
            method: 'POST', body: {note, start: true},
        })
        // The sessions panel above says who it reached, or that it waits for one.
        sent.value = {...sent.value, [pull.number]: {sent: true}}
    } catch (error) {
        sent.value = {...sent.value, [pull.number]: {failed: errorMessage(error, 'send')}}
    }
}

</script>

<template>
  <section v-if="got && (got.pulls.length || got.done?.length || got.error)" class="flex flex-col gap-2" aria-label="Pull requests">
    <h2 class="label flex items-center gap-2">
      Pull requests
      <span v-if="total" class="font-mono normal-case">{{ total }}</span>
    </h2>
    <ul v-if="total" class="overflow-hidden rounded-xl border border-line dark:bg-panel">
      <li v-for="pull in got.pulls" :key="pull.number" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-sm last:border-b-0">
        <svg class="size-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2" /></svg>
        <a :href="pull.url" target="_blank" rel="noopener" class="min-w-0 flex-1 truncate text-fg hover:underline">
          <span class="font-mono text-xs text-faint">#{{ pull.number }}</span> {{ pull.title }}
        </a>
        <PullStateChip :state="pull.state" />
        <template v-if="sendBackNote(pull)">
          <span v-if="sent[pull.number]?.sent" class="shrink-0 text-xs text-faint">Sent</span>
          <UiButton
              v-else
              size="xs"
              :disabled="sent[pull.number]?.busy"
              :title="`Ask a session to fix it: ${sendBackNote(pull)}`"
              @click="sendBack(pull)"
          ><UiBusy :busy="sent[pull.number]?.busy" label="Sending…">Send back</UiBusy></UiButton>
        </template>
        <span class="w-full truncate pl-7 font-mono text-[11px] text-faint" :title="`${pull.branch} into ${pull.base}, by ${pull.author}`">
          {{ pull.branch }} → {{ pull.base }} · {{ ago(pull.created_at) }}
        </span>
      </li>
      <li v-for="pull in got.done" :key="`done-${pull.number}`" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-sm last:border-b-0">
        <a :href="pull.url" target="_blank" rel="noopener" class="min-w-0 flex-1 truncate pl-7 text-muted hover:underline">
          <span class="font-mono text-xs text-faint">#{{ pull.number }}</span> {{ pull.title }}
        </a>
        <PullStateChip :state="pull.state" />
        <span class="w-full truncate pl-7 font-mono text-[11px] text-faint" :title="`${pull.branch} into ${pull.base}, by ${pull.author}`">
          {{ pull.branch }} → {{ pull.base }} · {{ ago(pull.merged_at ?? pull.updated_at) }}
        </span>
      </li>
    </ul>
    <p v-for="(state, number) in sent" v-show="state.failed" :key="number" class="text-xs text-rose-700 dark:text-rose-400">#{{ number }}: {{ state.failed }}</p>
    <p v-if="got.error" class="text-xs text-rose-700 dark:text-rose-400">{{ got.error }}</p>
  </section>
</template>
