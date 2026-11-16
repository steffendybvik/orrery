<script setup lang="ts">
import type {Session, SessionWork} from '#shared/roadmap'
import {asksQuestion, cutOffLabel} from '#shared/roadmap'
import {olderVersion} from '#shared/version'

// One Claude session on the Sessions page, as one summary line (ORR-1220), so five fit on a screen: its dot and name,
// the model it runs on, what it's doing and since when (what it asks, a cut-off), the issue it's on now, and its actions:
// one orrery started has Show screen out front and the rest under ⋯ (StartedSession); any other has its Stop under ⋯,
// as one nothing can reach isn't listed (ORR-716). Only one whose channel runs older code than this orrery says so there too.
// The name opens the rest (Details): the context it carries, the roles it plays, the projects it hears, its time left
// (one orrery started with a time), the folder it runs in and the context it was given; a message box for a listening
// one; then what it's on now (`work`, on `project`): its issues in progress, the rest it worked folded under them, and
// the latest thing it was sent, the rest folded too. One that hears other projects too says which: listed across
// projects (`spans`), every project it hears as a chip, or All projects; a global one says it has no project of its
// own. `lit` marks the one a link pointed at, and opens it. On a phone what it's doing takes a row of its own under the
// name, so the name isn't cut to a few letters (ORR-828).
const props = defineProps<{session: Session, project: string, work?: SessionWork, lit?: boolean, spans?: boolean}>()
const {who} = useOwner()
const {settings: appSettings} = useAppSettings()
const {projects} = useRoadmaps()
/** The other projects it hears, beside the one it's listed under, by name. */
const elsewhere = computed(() => [props.session.project, ...props.session.also ?? []]
    .filter(id => id !== props.project).map(id => projects.value.find(p => p.id === id)?.name ?? id))
const heard = computed(() => heardBy(props.session, projects.value))
const heardProjects = computed(() => heard.value.ids.map(id => projects.value.find(p => p.id === id) ?? {id, name: id, icon: undefined, icon_color: undefined}))
const viewing = ref(false)
/** Its Details are open: on a tap of its name, or once a link points at it. */
const open = ref(false)
watch(() => props.lit, lit => lit && (open.value = true), {immediate: true})
/** The presets it was started with, as badges by its name: the roles it plays. */
const {load, badgesFor} = usePresetBadges()
watchEffect(() => props.session.started?.context?.presets.length && load(props.session.project))
const roles = computed(() => badgesFor(props.session.project, props.session.started?.context?.presets ?? []))

const signalText = (s: SessionWork['signals'][number]) => s.kind === 'comment' ? `${who(s.created_by)}'s comment on ${s.issue}`
    : s.kind === 'message' ? (s.schedule === undefined ? `${who(s.created_by)}'s message${s.via === 'chat' ? ' via chat' : ''}: ${s.preset ?? s.note ?? ''}` : `${who(s.created_by)}'s scheduled message`)
    : s.issue ? `${who(s.created_by)}: focus on ${s.issue}` : `${who(s.created_by)}: work through milestone ${s.milestone}`
/** In progress first; the rest it worked are folded under them. */
const doing = computed(() => props.work?.issues.filter(i => i.kind === 'started') ?? [])
const rest = computed(() => props.work?.issues.filter(i => i.kind !== 'started') ?? [])
/** The latest thing it was sent; the rest are folded under it. */
const latest = computed(() => props.work?.signals[0])
/** The folder it runs in, by its name; the full path on hover. */
const folder = computed(() => props.session.cwd?.split('/').filter(Boolean).at(-1))
// Ticks once a minute, so a started session's time left stays right on an open page.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => timer = setInterval(() => now.value = Date.now(), 60_000))
onBeforeUnmount(() => clearInterval(timer))
const left = computed(() => {
    // One that runs until stopped (no time set in Starting sessions) says nothing.
    const stopsAt = props.session.started?.stops_at
    if (!stopsAt) return null
    const minutes = Math.round((Date.parse(stopsAt) - now.value) / 60_000)
    // Past its time, it's waiting to finish what it's on.
    if (minutes <= 0) return 'stops when done'
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`
})
const {environment, version} = useRuntimeConfig().public
const restart = (session: Session) => restartCommand(session, String(environment || 'personal'))
/** Its channel runs code older than this orrery's (ORR-434): it picks up the new as it restarts. */
const behind = computed(() => props.session.listening && olderVersion(props.session.version, String(version)))
</script>

<template>
  <li
      :id="`session-${session.id}`"
      class="flex scroll-mt-14 flex-col gap-3 rounded-xl border px-4 py-3 transition-colors duration-700"
      :class="lit ? 'border-accent-500/60 bg-accent-500/5' : 'border-line'"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
          type="button"
          class="-mx-1 flex min-w-0 shrink items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-hover"
          :aria-expanded="open"
          :aria-label="`Details for ${session.name}`"
          :title="open ? 'Hide its details' : 'Its context, folder, projects, message box and what it was sent'"
          @click="open = !open"
      >
        <svg class="size-3 shrink-0 text-faint transition-transform" :class="open && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        <SessionDot :session="session" />
        <span class="min-w-0 truncate text-[14px] font-medium text-fg">{{ session.name }}</span>
      </button>
      <!-- What it runs on and at what effort (ORR-871, ORR-894), as every place draws it (ORR-969). -->
      <ModelChip :session="session" class="shrink-0" />
      <p class="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs text-faint max-sm:order-last max-sm:basis-full max-sm:pl-5" data-testid="session-summary">
        <span class="shrink-0 whitespace-nowrap" :class="session.state === 'waiting' && 'text-rose-700 dark:text-rose-400'" :title="`Up since ${ago(session.started_at)}`">{{ stateLabel(session) }} · {{ ago(session.since) }}</span>
        <span v-if="session.cut_off" class="min-w-0 truncate text-amber-800 dark:text-amber-400" data-testid="session-cut-off">· {{ cutOffLabel(session.cut_off) }}<template v-if="session.cut_off.text">: {{ session.cut_off.text }}</template></span>
        <span v-if="asksQuestion(session) && session.asking?.questions?.length" class="min-w-0 truncate text-muted" :title="session.asking.questions.map(q => q.question).join('\n')" data-question>
          · {{ session.asking.questions[0]!.question }}
        </span>
        <span v-else-if="session.state === 'waiting' && session.asking && !asksQuestion(session)" class="inline-flex min-w-0 items-baseline gap-1" :title="session.asking.detail">
          · for <span class="text-muted">{{ toolLabel(session.asking.name) }}</span>
          <span v-if="session.asking.detail" class="min-w-0 truncate font-mono text-[11px] text-muted">{{ session.asking.detail }}</span>
        </span>
        <!-- The issue it's on now, the one thing worth knowing at a glance; the rest are under Details. -->
        <NuxtLink
            v-if="doing[0]"
            :to="`/p/${project}/issues/${doing[0].id}`"
            class="flex min-w-0 items-baseline gap-1.5 text-muted hover:text-fg"
            :title="doing.map(i => `${i.id} ${i.title}`).join('\n')"
            data-testid="session-now"
        >
          <span class="shrink-0">· on</span>
          <span class="shrink-0 font-mono text-[11px] text-faint">{{ doing[0].id }}</span>
          <span class="truncate">{{ doing[0].title }}</span>
          <span v-if="doing.length > 1" class="shrink-0 text-faint">+{{ doing.length - 1 }}</span>
        </NuxtLink>
        <span v-if="behind" class="shrink-0 whitespace-nowrap text-amber-800 dark:text-amber-400" :title="`Its channel runs ${session.version ?? 'code from before 1.0.0-rc.10'}, and this orrery ${version}: it picks up the new code as it restarts`">
          · on an older version
        </span>
      </p>
      <StartedSession v-model:viewing="viewing" :session="session" class="ml-auto" />
      <StopSession v-if="!session.started && session.reachable" :session="session" class="ml-auto" />
    </div>
    <SessionScreen v-if="viewing && session.started" :session="session" />

    <div v-show="open" class="flex flex-col gap-3 pl-5" data-testid="session-details">
      <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">
        <!-- How much context it carries (ORR-968). -->
        <ContextMeter :context="session.context" />
        <!-- And whether it took another issue's context into the one it's on (ORR-968). -->
        <span
            v-if="session.carried_over"
            class="text-[11px] text-amber-800 dark:text-amber-400"
            :title="`Started ${session.carried_over.to} with ${Math.round(session.carried_over.tokens / 1000)}k tokens of ${session.carried_over.from} in its context, which every turn pays for again. A clear between unrelated issues starts each afresh.`"
            data-testid="carried-over"
        >carries {{ session.carried_over.from }}</span>
        <span v-if="roles.length" class="flex items-center gap-1" :aria-label="`As ${roles.map(r => r.name).join(', ')}`">
          <span v-for="role in roles" :key="role.name" :title="role.name" class="inline-flex"><PresetBadge :preset="role" :size="18" /></span>
        </span>
        <template v-if="session.listening">
          <span v-if="spans && heard.all" class="rounded-md bg-well px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-line">All projects</span>
          <span v-else-if="spans" class="flex flex-wrap items-center gap-1" :aria-label="`Hears ${heardProjects.map(p => p.name).join(', ')}`">
            <span v-for="p in heardProjects" :key="p.id" class="flex items-center gap-1 rounded-md bg-well px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-line">
              <ProjectIcon v-if="p.icon && heroicon(p.icon)" :icon="p.icon" :color="p.icon_color" class="size-3" />
              {{ p.name }}
            </span>
          </span>
        </template>
        <span v-if="left" class="whitespace-nowrap" :title="session.started?.stops_at && `orrery started it; it stops at ${new Date(session.started.stops_at).toLocaleTimeString()}, or once it's done after that`">{{ left }}</span>
        <span v-if="session.started?.global" class="whitespace-nowrap" title="A global session: it hears every project, and a call names the one it's for (ORR-1079)">· global, no project of its own</span>
        <span v-if="folder" class="whitespace-nowrap" :title="session.cwd">· in <span class="font-mono">{{ folder }}/</span></span>
        <span v-if="session.started?.context">· with <span class="text-muted" :title="session.started.context.text">{{ contextLabel(session.started.context) }}</span></span>
        <NuxtLink v-if="appSettings.advanced" :to="{path: '/context', query: {project, session: session.id}}" class="whitespace-nowrap underline-offset-2 hover:text-fg hover:underline" title="What orrery puts into its context, part by part, with sizes">· Context</NuxtLink>
        <span v-if="session.listening && !spans && elsewhere.length" :title="`One session: it hears ${elsewhere.join(', ')} too`">· also on {{ elsewhere.join(', ') }}</span>
        <span v-if="behind" class="inline-flex flex-wrap items-center gap-1.5 text-amber-800 dark:text-amber-400">
          · started on {{ session.version ?? 'an older version' }}: {{ session.started ? 'stop it and start another' : 'restart it' }}
          <CopyButton v-if="!session.started" :text="restart(session)" label="Restart command" />
        </span>
      </p>
      <SessionMessage v-if="session.listening" :session="session" :project="project" />

      <div v-if="work?.issues.length || work?.signals.length" class="flex flex-col gap-2 border-t border-line pt-3">
        <div v-if="work.issues.length" class="flex min-w-0 flex-col gap-0.5">
          <h3 class="label px-1.5">Now</h3>
          <NuxtLink
              v-for="issue in doing"
              :key="issue.id"
              :to="`/p/${project}/issues/${issue.id}`"
              class="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-fg hover:bg-hover"
          >
            <StatusIcon :column="issue.column" class="shrink-0" />
            <span class="shrink-0 font-mono text-xs text-faint">{{ issue.id }}</span>
            <span class="truncate">{{ issue.title }}</span>
          </NuxtLink>
          <p v-if="!doing.length" class="px-1.5 py-1 text-xs text-faint">Nothing in progress.</p>
          <details v-if="rest.length" class="group">
            <summary class="flex list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs text-faint hover:text-muted">
              <svg class="size-3 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
              {{ rest.length }} more it worked on
            </summary>
            <NuxtLink
                v-for="issue in rest"
                :key="issue.id"
                :to="`/p/${project}/issues/${issue.id}`"
                class="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
            >
              <StatusIcon :column="issue.column" class="shrink-0" />
              <span class="shrink-0 font-mono text-xs text-faint">{{ issue.id }}</span>
              <span class="truncate">{{ issue.title }}</span>
            </NuxtLink>
          </details>
        </div>
        <details v-if="latest" class="group">
          <summary class="flex min-w-0 list-none items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-faint hover:text-muted">
            <svg v-if="work.signals.length > 1" class="size-3 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
            <span class="shrink-0">Last sent:</span>
            <span class="truncate text-muted">{{ signalText(latest) }}</span>
            <span class="shrink-0">· {{ ago(latest.created_at) }}</span>
          </summary>
          <p v-for="signal in work.signals.slice(1)" :key="signal.id" class="flex min-w-0 gap-1.5 py-0.5 pr-1.5 pl-6 text-xs text-muted">
            <span class="truncate">{{ signalText(signal) }}</span>
            <span class="shrink-0 text-faint">· {{ ago(signal.created_at) }}</span>
          </p>
        </details>
      </div>
    </div>
  </li>
</template>
