<script setup lang="ts">
import type {Session, SessionWork} from '#shared/roadmap'

// One Claude session on the Sessions page: what it's doing and since when, whether it can hear signals, where it
// runs, the issues it's on (`work`, on `project`) and what it was last sent. One Orrery started has its time left,
// Watch, +30 min and Stop; any other with its channel running, a Stop that ends it through the channel. A listening
// one takes a message. `lit` marks the one a link pointed at.
defineProps<{session: Session, project: string, work?: SessionWork, lit?: boolean}>()
const {who} = useOwner()

const signalText = (s: SessionWork['signals'][number]) => s.kind === 'comment' ? `${who(s.created_by)}'s comment on ${s.issue}`
    : s.kind === 'message' ? (s.schedule === undefined ? `${who(s.created_by)}'s message: ${s.note ?? ''}` : `${who(s.created_by)}'s scheduled message`)
    : s.issue ? `${who(s.created_by)}: focus on ${s.issue}` : `${who(s.created_by)}: work through chunk ${s.chunk}`
/** The command that starts the window again with the channel, keeping its name unless it was made up. */
const restart = (session: Session) => `${session.name.startsWith(`${session.project} `) ? '' : `ORRERY_SESSION=${session.name} `}claude --dangerously-load-development-channels server:${session.project}`
</script>

<template>
  <li
      :id="`session-${session.id}`"
      class="flex scroll-mt-14 flex-col gap-3 rounded-xl border p-4 transition-colors duration-700"
      :class="lit ? 'border-accent-500/60 bg-accent-500/5' : 'border-line'"
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
    <SessionMessage v-if="session.listening" :session="session" :project="project" />

    <div v-if="work?.issues.length || work?.signals.length" class="grid gap-4 border-t border-line pt-3 sm:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-1">
        <h3 class="label">Working on</h3>
        <NuxtLink
            v-for="issue in work.issues"
            :key="issue.id"
            :to="`/p/${project}/issues/${issue.id}`"
            class="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
        >
          <StatusIcon :column="issue.column" class="shrink-0" />
          <span class="shrink-0 font-mono text-xs text-faint">{{ issue.id }}</span>
          <span class="truncate">{{ issue.title }}</span>
        </NuxtLink>
        <p v-if="!work.issues.length" class="px-1.5 text-xs text-faint">No open issue.</p>
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <h3 class="label">Last sent</h3>
        <p v-for="signal in work.signals" :key="signal.id" class="flex min-w-0 gap-1.5 px-1.5 py-0.5 text-xs text-muted">
          <span class="truncate">{{ signalText(signal) }}</span>
          <span class="shrink-0 text-faint">· {{ ago(signal.created_at) }}</span>
        </p>
        <p v-if="!work.signals.length" class="px-1.5 text-xs text-faint">Nothing yet.</p>
      </div>
    </div>
  </li>
</template>
