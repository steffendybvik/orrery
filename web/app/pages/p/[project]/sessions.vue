<script setup lang="ts">
import type {Session, SessionWork} from '#shared/roadmap'
import {startsFor} from '#shared/roadmap'

// A project's Claude sessions, to browse: what each is doing and since when, whether it can hear signals, where
// it runs, the issues it's on and what it was last sent. One Orrery started has its time left, Watch, +30 min
// and Stop; any other with its channel running, a Stop that ends it through the channel. Start session has
// the project's launcher start one, once Orrery may. A sidebar row opens its session here
// (`#session-<id>`), lit up for a moment. Below the header, whether Orrery may start sessions and how many on it (`#starts`),
// then how starting them works.
const route = useRoute()
const {byId, ready, sessions: all} = useRoadmaps()
const {who} = useOwner()
const project = computed(() => byId(route.params.project as string))
const {settings} = useAppSettings()
const sessions = computed<Session[]>(() => all.value[route.params.project as string] ?? [])

// What each is on, asked again whenever the sessions change (a hook, a channel, a signal delivered).
const work = ref<Record<string, SessionWork>>({})
async function loadWork() {
    work.value = await $fetch<Record<string, SessionWork>>(`/api/projects/${encodeURIComponent(route.params.project as string)}/sessions/work`).catch(() => work.value)
}
watch(sessions, loadWork, {immediate: true})

// The session a link points at, scrolled to and lit up.
const lit = ref('')
async function show(hash: string) {
    const id = hash.replace(/^#session-/, '')
    if (!id || id === hash) return
    await nextTick()
    document.getElementById(`session-${id}`)?.scrollIntoView({block: 'center'})
    lit.value = id
    setTimeout(() => lit.value === id && (lit.value = ''), 1600)
}
watch(() => [route.hash, sessions.value.length] as const, ([hash]) => show(hash), {immediate: true})

const signalText = (s: SessionWork['signals'][number]) => s.kind === 'comment' ? `${who(s.created_by)}'s comment on ${s.issue}`
    : s.kind === 'message' ? `${who(s.created_by)}'s scheduled message`
    : s.issue ? `${who(s.created_by)}: focus on ${s.issue}` : `${who(s.created_by)}: work through chunk ${s.chunk}`
/** The command that starts the window again with the channel, keeping its name unless it was made up. */
const restart = (session: Session) => `${session.name.startsWith(`${session.project} `) ? '' : `ORRERY_SESSION=${session.name} `}claude --dangerously-load-development-channels server:${session.project}`
useHead(() => ({title: project.value ? `Sessions · ${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="project" class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-4 px-4 py-8 sm:px-8">
      <header class="flex items-start gap-3">
        <SectionIcon section="sessions" class="mt-0.5 size-4 text-accent-500" />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Sessions</h2>
          <p class="text-xs text-muted">
            The Claude sessions working on {{ project.name }}, as their hooks and channels last said.
            <template v-if="startsFor(project, settings)">Orrery starts more when your work finds nobody listening, or when you start one.</template>
          </p>
        </div>
        <StartSession :project="project" />
      </header>
      <SessionStarts id="starts" :project="project" class="scroll-mt-6" />
      <StartingSessionsGuide :project="project" />

      <ul v-if="sessions.length" class="flex flex-col gap-3">
        <li
            v-for="session in sessions"
            :id="`session-${session.id}`"
            :key="session.id"
            class="flex scroll-mt-6 flex-col gap-3 rounded-xl border p-4 transition-colors duration-700"
            :class="lit === session.id ? 'border-accent-500/60 bg-accent-500/5' : 'border-line'"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <SessionDot :session="session" />
            <span class="min-w-0 truncate text-[14px] font-medium text-fg">{{ session.name }}</span>
            <span class="text-xs" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">
              {{ SESSION_STATE[session.state] }} · {{ ago(session.since) }}
            </span>
            <span v-if="session.listening" class="text-xs text-emerald-600 dark:text-emerald-400">listening</span>
            <span v-else class="flex items-center gap-1.5 text-xs text-faint" :title="`${session.name} was started without the channel, so a signal can't reach it`">
              can't hear signals
              <CopyButton :text="restart(session)" label="Restart command" />
            </span>
            <StartedSession :session="session" class="ml-auto" />
            <StopSession v-if="!session.started && session.reachable" :session="session" class="ml-auto" />
          </div>
          <p class="text-xs text-faint">
            Up since {{ ago(session.started_at) }}<template v-if="session.cwd"> · in <span class="font-mono">{{ session.cwd }}</span></template>
            <template v-if="session.started?.context"> · with <span class="text-muted" :title="session.started.context.text">{{ contextLabel(session.started.context) }}</span></template>
          </p>

          <div v-if="work[session.id]?.issues.length || work[session.id]?.signals.length" class="grid gap-4 border-t border-line pt-3 sm:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1">
              <h3 class="label">Working on</h3>
              <NuxtLink
                  v-for="issue in work[session.id]!.issues"
                  :key="issue.id"
                  :to="`/p/${project.id}/issues/${issue.id}`"
                  class="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
              >
                <StatusIcon :column="issue.column" class="shrink-0" />
                <span class="shrink-0 font-mono text-xs text-faint">{{ issue.id }}</span>
                <span class="truncate">{{ issue.title }}</span>
              </NuxtLink>
              <p v-if="!work[session.id]!.issues.length" class="px-1.5 text-xs text-faint">No open issue.</p>
            </div>
            <div class="flex min-w-0 flex-col gap-1">
              <h3 class="label">Last sent</h3>
              <p v-for="signal in work[session.id]!.signals" :key="signal.id" class="flex min-w-0 gap-1.5 px-1.5 py-0.5 text-xs text-muted">
                <span class="truncate">{{ signalText(signal) }}</span>
                <span class="shrink-0 text-faint">· {{ ago(signal.created_at) }}</span>
              </p>
              <p v-if="!work[session.id]!.signals.length" class="px-1.5 text-xs text-faint">Nothing yet.</p>
            </div>
          </div>
        </li>
      </ul>
      <p v-else class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        No Claude session on {{ project.name }} has said hello yet.
        <NuxtLink :to="`/connect?project=${project.id}`" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">Connect one</NuxtLink>
        to see it here.
      </p>
    </div>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
