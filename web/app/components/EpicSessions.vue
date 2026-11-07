<script setup lang="ts">
import type {Column, Session, Signal} from '#shared/roadmap'

// On an epic's page (ORR-958): the sessions listening on its projects, each once, with Focus on this to point one at
// the epic, Focus all on this, and Focus on all <status> for each open status its issues are in. A focus goes to each
// of the epic's projects with open work that the session hears, so one that hears only some of them takes just
// those parts. `projects` are those with open work; `columns` the open statuses its issues are in. With nobody
// listening, the page's own Focus on this sends to orrery to pick or start one, so this says only that.
const props = defineProps<{epic: number, projects: string[], columns: Column[]}>()
const {sessions: all, byId} = useRoadmaps()

const listeners = computed(() => listeningOn(props.projects, all.value))
const listening = computed(() => listeners.value.map(l => l.session))
const spans = computed(() => props.projects.length > 1)
const name = (id: string) => byId(id)?.name ?? id

const sending = ref<string | null>(null)
const note = ref('')
const failed = ref('')
async function focus(session: Session | '*') {
    sending.value = session === '*' ? 'all' : session.id
    failed.value = ''
    try {
        const {signals} = await apiFetch<{signals: Signal[]}>(`/epics/${props.epic}/focus`, {method: 'POST', body: {session: session === '*' ? '*' : session.id}})
        const parts = signals.length === 1 ? name(signals[0]?.project ?? '') : `${signals.length} projects`
        note.value = session === '*' ? `Sent to all ${listening.value.length} sessions, on ${parts}` : `Sent to ${session.name}, on ${parts}`
        setTimeout(() => note.value = '', 4000)
    } catch (error) {
        failed.value = errorMessage(error, 'send')
    } finally {
        sending.value = null
    }
}
</script>

<template>
  <section class="flex flex-col gap-3 rounded-2xl bg-well/50 p-4 ring-1 ring-line dark:bg-panel" aria-label="Sessions">
    <div class="flex flex-wrap items-center gap-2">
      <svg class="size-4 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
      <h2 class="text-[13px] font-medium text-fg">Sessions</h2>
      <span class="text-xs text-faint">{{ listening.length ? `${listening.length} listening` : 'none listening' }}</span>
      <span v-if="listening.length" class="ml-auto flex flex-wrap items-center gap-2">
        <StatusFocus v-for="column in columns" :key="column" :epic="epic" :listening="listening" :column="column" />
        <UiButton
            v-if="listening.length > 1"
            :disabled="!!sending"
            title="Ask every listening session to work through the epic's open issues, in the projects it hears"
            @click="focus('*')"
        ><UiBusy :busy="sending === 'all'" label="Sending…">Focus all on this</UiBusy></UiButton>
      </span>
    </div>

    <ul v-if="listeners.length" class="flex flex-col">
      <SessionsPanelRow
          v-for="{session, hears} in listeners"
          :key="session.id"
          :session="session"
          what="this epic"
          :sending="sending"
          @focus="focus(session)"
      >
        <span v-if="spans" class="text-xs text-faint" :title="`A focus from here goes to its part in ${hears.map(name).join(', ')}`">
          {{ hears.length === projects.length ? 'hears all its projects' : `hears ${hears.map(name).join(', ')}` }}
        </span>
      </SessionsPanelRow>
    </ul>
    <p v-else class="text-[13px] leading-relaxed text-muted">
      No session is listening on {{ spans ? 'its projects' : name(projects[0] ?? '') }}. Focus on this, above, has orrery pick one in each, or start one where it may.
    </p>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    <p v-else-if="note" class="text-xs text-emerald-600 dark:text-emerald-400" role="status">{{ note }}</p>
  </section>
</template>
