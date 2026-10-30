<script setup lang="ts">
import type {ContextEntry, ContextKind, ContextPart, ContextView} from '#shared/context'

// What orrery puts into a session's context, part by part with its size (ORR-549), to see what to cut: the channel's
// instructions, each tool it lists and the context the session was started with, biggest first, each part's text
// folded under it. For a kind of session on a project (`?project=&kind=`), or a running one (`?session=`, from its
// card on the Sessions page), which also lists what it's been given so far: each signal and tool answer, newest first.
// It's in the sidebar while Advanced is on (ORR-578), and on App settings → Advanced (ORR-561).
useHead({title: 'Context · orrery'})
const route = useRoute()
const router = useRouter()
const {settings} = useAppSettings()
const {ordered} = useProjectOrder()

const project = computed({
    get: () => (route.query.project as string | undefined) || ordered.value[0]?.id || '',
    set: id => router.replace({query: {...route.query, project: id, session: undefined}}),
})
const kind = computed({
    get: () => ((route.query.kind as string | undefined) ?? 'work') as ContextKind,
    set: k => router.replace({query: {...route.query, kind: k, session: undefined}}),
})
const session = computed(() => route.query.session as string | undefined)

const KINDS: {value: ContextKind, label: string}[] = [{value: 'work', label: 'Work session'}, {value: 'chat', label: 'Chat'}, {value: 'untrusted', label: 'Untrusted run'}]
const GROUPS: Record<ContextPart['group'], {label: string, bar: string}> = {
    instructions: {label: 'Instructions', bar: 'bg-sky-500'},
    tools: {label: 'Tools', bar: 'bg-violet-500'},
    start: {label: 'Start context', bar: 'bg-amber-500'},
}

const view = ref<ContextView | null>(null)
const failed = ref('')
watch([project, kind, session], async ([p, k, s]) => {
    if (!p) return
    failed.value = ''
    try {
        view.value = await apiFetch<ContextView>(`/projects/${encodeURIComponent(p)}/context`, {query: s ? {session: s} : {kind: k}})
    } catch (error) {
        view.value = null
        failed.value = (error as {data?: {message?: string}}).data?.message ?? 'It couldn’t be read.'
    }
}, {immediate: true})

const projectOptions = computed(() => ordered.value.map(p => ({value: p.id, label: p.name})))
/** Each group's share, for the bar and the legend. */
const groups = computed(() => {
    const v = view.value
    if (!v) return []
    return (Object.keys(GROUPS) as ContextPart['group'][]).map(group => {
        const chars = v.parts.filter(p => p.group === group).reduce((sum, p) => sum + p.chars, 0)
        return {group, chars, share: v.chars ? chars / v.chars : 0}
    }).filter(g => g.chars)
})
/** Biggest first, across the groups. */
const parts = computed(() => view.value?.parts.toSorted((a, b) => b.chars - a.chars) ?? [])
/** What a running session has been given so far and still holds, in all: not what came before its last clear (ORR-575). */
const sofarChars = computed(() => view.value?.sofar?.reduce((sum, e) => e.before ? sum : sum + e.chars, 0) ?? 0)
/** Where its entries from before the last clear or compaction start, in the list (newest first). */
const firstBefore = computed(() => view.value?.sofar?.findIndex(e => e.before) ?? -1)
const SOFAR: Record<ContextEntry['kind'], {label: string, bar: string}> = {signal: {label: 'Signal', bar: 'bg-emerald-500'}, tool: {label: 'Tool answer', bar: 'bg-rose-500'}}
const time = (at: string) => new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit'})
const pct = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`
const n = (value: number) => value.toLocaleString('en')
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M9 19v-8M14 19V9M19 19v-4" /></svg>
    <h1 class="truncate text-sm font-medium">Context</h1>
  </PageHeader>

  <ViewToolbar>
    <PropertyPicker v-model="project" :options="projectOptions" label="Project" field small>
      <span class="truncate">{{ projectOptions.find(o => o.value === project)?.label ?? project }}</span>
    </PropertyPicker>
    <div class="flex shrink-0 items-center gap-1" role="group" aria-label="Kind of session">
      <button
          v-for="k in KINDS"
          :key="k.value"
          type="button"
          class="h-6 rounded-md px-2 text-xs ring-1"
          :class="!session && kind === k.value ? 'bg-active font-medium text-fg ring-line' : 'text-muted ring-transparent hover:text-fg'"
          :aria-pressed="!session && kind === k.value"
          @click="kind = k.value"
      >
        {{ k.label }}
      </button>
    </div>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
    <div class="mx-auto flex max-w-4xl flex-col gap-4">
      <p v-if="!settings.advanced" class="rounded-lg bg-well px-3 py-2 text-xs text-muted ring-1 ring-line">
        This is for Advanced: turn it on in
        <NuxtLink to="/settings?tab=advanced" class="underline underline-offset-2 hover:text-fg">App settings</NuxtLink>
        to see a running session's from its card.
      </p>
      <p v-if="failed" class="text-sm text-rose-600 dark:text-rose-400">{{ failed }}</p>

      <section v-if="view" aria-label="Total" class="flex flex-col gap-2">
        <p class="text-sm">
          <template v-if="view.session">Session <span class="font-mono">{{ view.session }}</span> ({{ KINDS.find(k => k.value === view!.kind)?.label }}, hearing {{ view.projects.join(', ') }})</template>
          <template v-else>A {{ KINDS.find(k => k.value === view!.kind)?.label.toLowerCase() }} on {{ view.projects.join(', ') }}</template>
          is given <strong data-testid="context-total">{{ n(view.chars) }} characters</strong>, about {{ n(view.tokens) }} tokens, as it connects.
        </p>
        <div class="flex h-3 overflow-hidden rounded-full bg-well ring-1 ring-line" role="img" :aria-label="groups.map(g => `${GROUPS[g.group].label} ${pct(g.share)}`).join(', ')">
          <div v-for="g in groups" :key="g.group" :class="GROUPS[g.group].bar" :style="{width: pct(g.share)}" />
        </div>
        <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <li v-for="g in groups" :key="g.group" class="flex items-center gap-1.5">
            <span class="size-2 rounded-full" :class="GROUPS[g.group].bar" />
            {{ GROUPS[g.group].label }} · {{ n(g.chars) }} · {{ pct(g.share) }}
          </li>
        </ul>
        <p class="text-xs text-faint">
          Tokens are estimated as a quarter of the characters. Signals and what its tool calls return come on top, as the session works: a running session's are under So far.
        </p>
      </section>

      <ul v-if="view" aria-label="Parts" class="flex flex-col divide-y divide-line rounded-lg ring-1 ring-line">
        <li v-for="p in parts" :key="p.id">
          <details class="group">
            <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-hover sm:gap-3">
              <svg class="size-3 shrink-0 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
              <span class="size-2 shrink-0 rounded-full" :class="GROUPS[p.group].bar" :title="GROUPS[p.group].label" />
              <span class="min-w-0 flex-1 truncate" :class="p.group === 'tools' && 'font-mono text-xs'">{{ p.title }}</span>
              <span class="hidden w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted sm:block">{{ n(p.chars) }}</span>
              <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-faint sm:w-20">~{{ n(p.tokens) }} tok</span>
              <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-faint sm:w-14">{{ pct(view.chars ? p.chars / view.chars : 0) }}</span>
            </summary>
            <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-well px-3 py-2 font-mono text-[11px] leading-4 text-muted">{{ p.group === 'tools' ? JSON.stringify(JSON.parse(p.text), null, 2) : p.text }}</pre>
          </details>
        </li>
      </ul>

      <section v-if="view?.sofar" aria-label="So far" class="flex flex-col gap-2">
        <h2 class="text-sm font-medium">So far</h2>
        <p class="text-xs text-muted">
          <template v-if="view.sofar.length">
            Its latest {{ view.sofar.length }} signals and tool answers. In its context now: <span data-testid="context-sofar-total">{{ n(sofarChars) }} characters</span>, about {{ n(Math.ceil(sofarChars / 4)) }} tokens.
            Each stays in its context once given, until a /clear or a compaction. Kept since orrery last started.
          </template>
          <template v-else>Nothing yet: its signals and tool answers show here as it's given them.</template>
        </p>
        <ul v-if="view.sofar.length" class="flex flex-col divide-y divide-line rounded-lg ring-1 ring-line">
          <li v-for="(e, i) in view.sofar" :key="`${e.at}-${i}`" :class="e.before ? 'opacity-60' : ''">
            <p v-if="i === firstBefore" class="border-b border-line bg-well px-3 py-1.5 text-xs text-muted" data-testid="context-sofar-before">Before its last /clear or compaction: no longer in its context, and not in the total</p>
            <details class="group">
              <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-hover sm:gap-3">
                <svg class="size-3 shrink-0 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
                <span class="size-2 shrink-0 rounded-full" :class="SOFAR[e.kind].bar" :title="SOFAR[e.kind].label" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ e.title }}</span>
                <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-faint sm:w-20">{{ time(e.at) }}</span>
                <span class="hidden w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted sm:block">{{ n(e.chars) }}</span>
                <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-faint sm:w-20">~{{ n(e.tokens) }} tok</span>
              </summary>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-well px-3 py-2 font-mono text-[11px] leading-4 text-muted"><template v-if="!e.text && e.chars">(not kept: it's what an outside service sent back)</template><template v-else>{{ e.text }}<template v-if="e.text.length < e.chars">
…(cut, {{ n(e.chars - e.text.length) }} more characters)</template></template></pre>
            </details>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
