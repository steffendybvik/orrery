<script setup lang="ts">
import type {Session, Signal} from '#shared/roadmap'

// On an issue's page: the Claude sessions working on its project, what each is doing, and a button
// to point one (or all) at this issue. Under them, the focus signals sent about it and who got them.
const props = defineProps<{project: string, issue: string}>()
const {sessions: all, signals: live} = useRoadmaps()
const {load} = useOwner()

const sessions = computed(() => all.value[props.project] ?? [])
const listening = computed(() => sessions.value.filter(s => s.listening))
const sent = ref<Signal[]>([])
const sending = ref<string | null>(null)
const failed = ref(false)

const STATE = {idle: 'idle', working: 'working', waiting: 'needs you', starting: 'starting'}

async function loadSent() {
    sent.value = await $fetch<Signal[]>(`/api/projects/${encodeURIComponent(props.project)}/signals`, {query: {issue: props.issue}}).catch(() => [])
}
watch(() => props.issue, loadSent, {immediate: true})
// Signals sent or delivered just now, from the live stream.
watch(live, now => {
    for (const signal of now) {
        if (signal.project !== props.project || signal.issue !== props.issue) continue
        sent.value = [...sent.value.filter(s => s.id !== signal.id), signal].sort((a, b) => a.id - b.id)
    }
})

async function focus(session: Session | null) {
    sending.value = session?.id ?? 'all'
    failed.value = false
    try {
        const owner = await load()
        const {signal} = await $fetch<{signal: Signal}>(`/api/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/focus`, {
            method: 'POST', headers: {'Orrery-Actor': owner}, body: session ? {session: session.id} : {},
        })
        sent.value = [...sent.value.filter(s => s.id !== signal.id), signal]
    } catch {
        failed.value = true
    } finally {
        sending.value = null
    }
}

const nameOf = (id?: string) => sessions.value.find(s => s.id === id)?.name ?? 'a session'
/** The command that starts the window again with the channel, keeping its name unless it was made up. */
const restart = (session: Session) => `${session.name.startsWith(`${props.project} `) ? '' : `ORRERY_SESSION=${session.name} `}claude --dangerously-load-development-channels server:orrery`
</script>

<template>
  <section class="flex flex-col gap-3 rounded-2xl bg-well/50 p-4 ring-1 ring-line">
    <div class="flex items-center gap-2">
      <svg class="size-4 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
      <h2 class="text-[13px] font-medium text-fg">Claude sessions</h2>
      <span class="text-xs text-faint">{{ listening.length ? `${listening.length} listening` : 'none listening' }}</span>
      <button
          v-if="listening.length > 1"
          type="button"
          class="ml-auto h-7 rounded-md px-2.5 text-xs text-muted ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50"
          :disabled="!!sending"
          @click="focus(null)"
      >Focus all on this</button>
    </div>

    <ul v-if="sessions.length" class="flex flex-col">
      <li v-for="session in sessions" :key="session.id" class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
        <SessionDot :session="session" />
        <span class="min-w-0 truncate text-[13px] text-fg">{{ session.name }}</span>
        <span class="text-xs" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">
          {{ STATE[session.state] }} · {{ ago(session.since) }}
        </span>
        <button
            v-if="session.listening"
            type="button"
            class="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ring-1 transition-colors disabled:opacity-50"
            :class="session.state === 'idle' ? 'bg-accent-500/10 text-accent-700 ring-accent-500/40 hover:bg-accent-500/20 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
            :disabled="!!sending"
            :title="`Ask ${session.name} to work on this now`"
            @click="focus(session)"
        >
          {{ sending === session.id ? 'Sending…' : 'Focus on this' }}
        </button>
        <span v-else class="ml-auto flex shrink-0 items-center gap-2 text-xs text-faint" :title="`${session.name} was started without the orrery channel, so a signal can't reach it`">
          can't hear signals: restart it with
          <CopyButton :text="restart(session)" label="Copy command" />
        </span>
      </li>
    </ul>
    <p v-else class="text-[13px] leading-relaxed text-muted">
      No Claude session on {{ project }} has said hello yet.
      <NuxtLink :to="`/connect?project=${project}`" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">Connect one</NuxtLink>
      to point it at issues from here.
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">Couldn't send. Is Orrery running?</p>

    <ol v-if="sent.length" class="flex flex-col gap-1 border-t border-line pt-3 text-xs text-faint">
      <li v-for="signal in sent.slice(-5)" :key="signal.id" class="flex flex-wrap items-center gap-x-1.5">
        <template v-if="signal.kind === 'comment'">
          <span class="text-muted">{{ signal.createdBy }}</span>'s comment went to
          <span class="text-muted">{{ signal.target ? nameOf(signal.target) : 'every session' }}</span>
        </template>
        <template v-else>
          <span class="text-muted">{{ signal.createdBy }}</span> asked
          <span class="text-muted">{{ signal.target ? nameOf(signal.target) : 'every session' }}</span> to focus on this
        </template>
        · {{ ago(signal.createdAt) }} ·
        <span v-if="signal.deliveredTo.length" class="text-emerald-600 dark:text-emerald-400">delivered to {{ signal.deliveredTo.join(', ') }}</span>
        <span v-else-if="!signal.protected">not sent on (only the owner's signals reach sessions)</span>
        <span v-else>not delivered</span>
      </li>
    </ol>
  </section>
</template>
