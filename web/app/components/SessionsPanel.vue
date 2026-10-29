<script setup lang="ts">
import type {Session, Signal} from '#shared/roadmap'

// On an issue's (or a chunk's) page: the Claude sessions working on its project, what each is doing, and
// a button to point one (or all) at this issue, or at working through this chunk. With nobody listening, when
// orrery may start sessions and the project's launcher is there, the same focus starts one; with some listening,
// New session on this starts another, on this issue alone. Under them, the focus signals sent about it and who
// got them. The session working the issue (`worker`) comes first, marked. A session's own controls (watch, stop, more time) live on its card on the Sessions page, which its name
// links to; here a row only points it at this. An issue still blocked (ORR-601) says so first: a focus starts it anyway.
const props = defineProps<{project: string, issue?: string, chunk?: string, worker?: string, blockedBy?: string[]}>()
const about = computed(() => props.issue ? {issue: props.issue} : {chunk: props.chunk})
const path = computed(() => props.issue ? `issues/${encodeURIComponent(props.issue)}` : `chunks/${encodeURIComponent(props.chunk ?? '')}`)
const {sessions: all, signals: live, byId} = useRoadmaps()
const {settings} = useAppSettings()
const {load, who} = useOwner()
const {look} = useStatuses()

const sessions = computed(() => [...all.value[props.project] ?? []].sort((a, b) => Number(b.id === props.worker) - Number(a.id === props.worker)))
const listening = computed(() => sessions.value.filter(s => s.listening))
// Whether a focus sent with nobody listening has a session started for it.
const {state: launch} = useLaunchState(() => props.project)
const canStart = computed(() => !listening.value.length && !!byId(props.project)?.starts && !!launch.value?.launchers)
// Whether a new session can start for this issue alongside those listening: a launcher, and room under the limit.
const canStartAnother = computed(() => {
    const starts = byId(props.project)?.starts
    return !!props.issue && !!listening.value.length && !!starts && !!launch.value?.launchers && launch.value.total < starts.limit
})
const sent = ref<Signal[]>([])
const sending = ref<string | null>(null)
const failed = ref<string | null>(null)


async function loadSent() {
    sent.value = await $fetch<Signal[]>(`/api/projects/${encodeURIComponent(props.project)}/signals`, {query: about.value}).catch(() => [])
}
watch(path, loadSent, {immediate: true})
// Signals sent or delivered just now, from the live stream.
watch(live, now => {
    for (const signal of now) {
        if (signal.project !== props.project || (props.issue ? signal.issue !== props.issue : signal.chunk !== props.chunk)) continue
        sent.value = [...sent.value.filter(s => s.id !== signal.id), signal].sort((a, b) => a.id - b.id)
    }
})

// The standing instructions that can go with it (the orrery's the project keeps, and its own), ticked as
// they are by default; unticking one leaves it out of this send only.
const offered = computed(() => {
    const project = byId(props.project)
    return [...settings.value.instructions.filter(i => !(project?.muted ?? []).includes(i.id)), ...project?.instructions ?? []]
})
const ticked = ref<string[]>([])
watch(() => offered.value.map(i => `${i.id}:${i.on}`).join(), () => ticked.value = offered.value.filter(i => i.on).map(i => i.id), {immediate: true})

/** Sends the focus; `start` asks orrery to start a session for it, nobody being there to hear it. */
async function focus(session: Session | null, start = false) {
    sending.value = session?.id ?? 'all'
    failed.value = null
    try {
        const owner = await load()
        const {signal} = await $fetch<{signal: Signal}>(`/api/projects/${encodeURIComponent(props.project)}/${path.value}/focus`, {
            method: 'POST', headers: {'Orrery-Actor': owner}, body: {...session ? {session: session.id} : {}, ...start ? {start} : {}, ...offered.value.length ? {instructions: ticked.value} : {}},
        })
        sent.value = [...sent.value.filter(s => s.id !== signal.id), signal]
    } catch {
        failed.value = "Couldn't send. Is orrery running?"
    } finally {
        sending.value = null
    }
}

/** Starts a new session through the launcher, focused on this issue alone; it shows up above as it arrives. */
async function startOn() {
    sending.value = 'new'
    failed.value = null
    try {
        const owner = await load()
        await $fetch(`/api/projects/${encodeURIComponent(props.project)}/launches`, {method: 'POST', headers: {'Orrery-Actor': owner}, body: {issue: props.issue, hears: [props.project]}})
    } catch (error) {
        failed.value = errorMessage(error, 'start')
    } finally {
        sending.value = null
    }
}

const nameOf = (id?: string) => sessions.value.find(s => s.id === id)?.name ?? 'a session'
/** Who a signal was for: a session, every session, one started for it (aimed at `launch-<id>` until it connects),
 * or (a comment aside) the one orrery picks. */
const aimed = (signal: Signal) => signal.target === '*' || !signal.target && signal.kind === 'comment' ? 'every session'
    : signal.target?.startsWith('launch-') && !sessions.value.some(s => s.id === signal.target) ? 'a new session'
        : signal.target ? nameOf(signal.target) : 'one session'
const {environment} = useRuntimeConfig().public
const restart = (session: Session) => restartCommand({name: session.name, project: props.project, server: session.server}, String(environment || 'personal'))
</script>

<template>
  <section class="flex flex-col gap-3 rounded-2xl bg-well/50 p-4 ring-1 ring-line dark:bg-panel">
    <div class="flex items-center gap-2">
      <svg class="size-4 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
      <h2 class="text-[13px] font-medium text-fg">Sessions</h2>
      <span class="text-xs text-faint">{{ listening.length ? `${listening.length} listening` : 'none listening' }}</span>
      <span v-if="listening.length" class="ml-auto flex items-center gap-2">
        <UiButton
            v-if="canStartAnother"
            :disabled="!!sending"
            :title="`orrery starts another session on ${project}, working on this issue alone`"
            @click="startOn"
        >{{ sending === 'new' ? 'Starting…' : 'New session on this' }}</UiButton>
        <UiButton
            v-if="listening.length > 1"
            :disabled="!!sending"
            @click="focus(null)"
        >Focus all on this</UiButton>
      </span>
      <button
          v-else-if="canStart"
          type="button"
          class="ml-auto h-7 rounded-md bg-accent-500/10 px-2.5 text-xs font-medium text-accent-700 ring-1 ring-accent-500/40 hover:bg-accent-500/20 disabled:opacity-50 dark:text-accent-300"
          :disabled="!!sending"
          :title="`orrery starts a session on ${project} and asks it to ${issue ? 'work on this' : 'work through this chunk'}`"
          @click="focus(null, true)"
      >{{ sending === 'all' ? 'Starting…' : issue ? 'Focus on this (starts a session)' : 'Work through this (starts a session)' }}</button>
    </div>

    <p v-if="blockedBy?.length && (listening.length || canStart)" class="text-xs text-amber-700 dark:text-amber-400">
      Blocked by {{ blockedBy.join(', ') }}, which {{ blockedBy.length === 1 ? "isn't" : "aren't" }} done yet. A focus starts it anyway.
    </p>

    <fieldset v-if="(listening.length || canStart) && offered.length" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <legend class="sr-only">Standing instructions for this focus</legend>
      <span class="text-faint">With it:</span>
      <label v-for="i in offered" :key="i.id" class="flex items-center gap-1.5" :class="ticked.includes(i.id) ? 'text-muted' : 'text-faint'">
        <input v-model="ticked" type="checkbox" :value="i.id" class="size-3 accent-accent-500">
        {{ i.text }}
      </label>
    </fieldset>

    <ul v-if="sessions.length" class="flex flex-col">
      <li v-for="session in sessions" :key="session.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-2 hover:bg-hover">
        <SessionDot :session="session" />
        <NuxtLink
            :to="`/sessions#session-${session.id}`"
            class="min-w-0 truncate text-[13px] text-fg hover:underline"
            :title="`Open ${session.name} on the Sessions page`"
        >{{ session.name }}</NuxtLink>
        <span v-if="session.id === worker" class="rounded-full bg-accent-500/10 px-1.5 text-[11px] font-medium text-accent-700 ring-1 ring-accent-500/30 dark:text-accent-300">on this issue</span>
        <span class="whitespace-nowrap text-xs" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">
          {{ SESSION_STATE[session.state] }} · {{ ago(session.since) }}
        </span>
        <button
            v-if="session.listening"
            type="button"
            class="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ring-1 transition-colors disabled:opacity-50"
            :class="session.state === 'idle' ? 'bg-accent-500/10 text-accent-700 ring-accent-500/40 hover:bg-accent-500/20 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
            :disabled="!!sending"
            :title="issue ? `Ask ${session.name} to work on this now` : `Ask ${session.name} to work through this chunk now`"
            @click="focus(session)"
        >
          {{ sending === session.id ? 'Sending…' : 'Focus on this' }}
        </button>
        <span v-else class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-faint" :title="`${session.name} was started without the orrery channel, so a signal can't reach it`">
          can't hear signals: restart it with
          <CopyButton :text="restart(session)" label="Copy command" />
        </span>
      </li>
    </ul>
    <p v-else-if="canStart" class="text-[13px] leading-relaxed text-muted">
      No session on {{ project }} yet. {{ issue ? 'Focus on this' : 'Work through this' }} has orrery start one, in its repo, through the launcher.
    </p>
    <p v-else class="text-[13px] leading-relaxed text-muted">
      No session on {{ project }} has said hello yet.
      <NuxtLink :to="`/connect?project=${project}`" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">Connect one</NuxtLink>
      to point it at issues from here.
      <template v-if="byId(project)?.starts && launch && !launch.launchers">
        No launcher is running for it, so orrery can't start one:
        <NuxtLink to="/sessions#starts" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">how to install it</NuxtLink>.
      </template>
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>

    <ol v-if="sent.length" class="flex flex-col gap-1 border-t border-line pt-3 text-xs text-faint">
      <li v-for="signal in sent.slice(-5)" :key="signal.id" class="flex flex-wrap items-center gap-x-1.5">
        <template v-if="signal.kind === 'comment'">
          <span><span class="text-muted">{{ who(signal.created_by) }}</span>'s comment went to</span>
          <span class="text-muted">{{ aimed(signal) }}</span>
        </template>
        <template v-else>
          <span class="text-muted">{{ who(signal.created_by) }}</span> asked
          <span class="text-muted">{{ aimed(signal) }}</span>
          {{ signal.status ? `to work through its ${look(signal.status).label} issues` : 'to focus on this' }}
        </template>
        · {{ ago(signal.created_at) }} ·
        <span v-if="signal.delivered_to.length" class="text-emerald-600 dark:text-emerald-400">delivered to {{ signal.delivered_to.join(', ') }}</span>
        <span v-else-if="!signal.protected">not sent on (only the owner's signals reach sessions)</span>
        <span v-else>not delivered</span>
      </li>
    </ol>
  </section>
</template>
