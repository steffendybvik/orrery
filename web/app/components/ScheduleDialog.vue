<script setup lang="ts">
import type {Priority, Schedule} from '#shared/roadmap'
import type {Repeat} from '~/utils/schedule'

// Writing a schedule, or changing one, as the owner: in a project, whether each run makes an issue or
// only sends a message to the project's Claude sessions, what it says, when it runs (presets, or a cron
// under Advanced) with its next times shown, and for an issue where it starts and whether it asks the
// sessions to pick it up. One already made can be paused or resumed from here, at once. ⌘↵ saves, Esc
// closes.
const {editing, pause} = useSchedules()
const {byId} = useRoadmaps()
const {load} = useOwner()

const KINDS: {value: Repeat['kind'], label: string}[] = [
    {value: 'daily', label: 'Every day'}, {value: 'weekdays', label: 'Weekdays'}, {value: 'weekly', label: 'Some days of the week'},
    {value: 'monthly', label: 'Monthly'}, {value: 'minutes', label: 'Every N minutes'}, {value: 'hours', label: 'Every N hours'},
    {value: 'once', label: 'Once'}, {value: 'cron', label: 'Advanced (cron)'},
]
// Where its issues start: any open status.
const {places} = useStatuses()
const starts = computed(() => places.value.filter(p => p.kind !== 'proposed' && !isClosed(p.kind)))

const project = ref('')
const sends = ref<'issue' | 'message'>('issue')
const SENDS = [{value: 'issue' as const, label: 'Makes an issue'}, {value: 'message' as const, label: 'Sends a message'}]
const title = ref('')
const notes = ref('')
const kind = ref<Repeat['kind']>('weekdays')
const time = ref('09:00')
const days = ref<number[]>([1])
const day = ref(1)
const every = ref(4)
const everyMinutes = ref(15)
const minute = ref(0)
const once = ref('')
const cron = ref('0 9 * * 1-5')
const timezone = ref(localZone())
const column = ref('todo')
const chunk = ref('')
const priority = ref<Priority | ''>('')
const labels = ref<string[]>([])
const ask = ref(false)
const skipOpen = ref(true)
const enabled = ref(true)
const pausing = ref(false)
const saving = ref(false)
const failed = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const existing = computed(() => editing.value?.schedule)
const here = computed(() => byId(project.value))
const chunks = computed(() => here.value?.board.chunks.filter(c => c.id) ?? [])
const startOptions = computed(() => starts.value.map(p => ({value: p.id, label: p.label})))
const chunkOptions = computed(() => [{value: '', label: 'No chunk'}, ...chunks.value.map(c => ({value: c.id, label: c.title}))])
// The pickers hold strings; the counts are numbers.
const MINUTES = [5, 10, 15, 20, 30].map(n => ({value: String(n), label: `${n} minutes`}))
const HOURS = [1, 2, 3, 4, 6, 8, 12].map(n => ({value: String(n), label: n === 1 ? 'hour' : `${n} hours`}))
const everyMinutesPicked = computed({get: () => String(everyMinutes.value), set: v => everyMinutes.value = Number(v)})
const everyPicked = computed({get: () => String(every.value), set: v => every.value = Number(v)})
const label = (options: {value: string, label: string}[], value: string) => options.find(o => o.value === value)?.label
const known = computed(() => here.value ? [...new Set(allIssues(here.value).flatMap(({issue}) => issue.labels))] : [])

/** A time as `datetime-local` wants it, in this browser's zone. */
const local = (iso: string) => {
    const d = new Date(iso)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

watch(editing, now => {
    if (!now) return
    const s = now.schedule
    project.value = now.project
    sends.value = s?.kind ?? 'issue'
    title.value = s?.title ?? ''
    notes.value = s?.notes ?? ''
    timezone.value = s?.timezone ?? localZone()
    column.value = s?.column ?? starts.value.find(p => p.kind === 'todo')?.id ?? 'todo'
    chunk.value = s?.chunk ?? ''
    priority.value = s?.priority ?? ''
    labels.value = [...s?.labels ?? []]
    ask.value = s?.ask ?? false
    skipOpen.value = s?.skip_open ?? true
    enabled.value = s?.enabled ?? true
    const repeat: Repeat = s ? toRepeat(s) : {kind: 'weekdays', time: '09:00'}
    kind.value = repeat.kind
    if ('time' in repeat) time.value = repeat.time
    if (repeat.kind === 'weekly') days.value = [...repeat.days]
    if (repeat.kind === 'monthly') day.value = repeat.day
    if (repeat.kind === 'minutes') everyMinutes.value = repeat.every
    if (repeat.kind === 'hours') {
        every.value = repeat.every
        minute.value = repeat.minute
    }
    once.value = repeat.kind === 'once' ? local(repeat.at) : local(new Date(Date.now() + 3600_000).toISOString())
    cron.value = s?.cron ?? '0 9 * * 1-5'
    failed.value = ''
    nextTick(() => titleInput.value?.focus())
}, {immediate: true})

const repeat = computed<Repeat>(() => {
    switch (kind.value) {
        case 'weekly': return {kind: 'weekly', time: time.value, days: days.value}
        case 'monthly': return {kind: 'monthly', time: time.value, day: day.value}
        case 'minutes': return {kind: 'minutes', every: everyMinutes.value}
        case 'hours': return {kind: 'hours', every: every.value, minute: minute.value}
        case 'once': return {kind: 'once', at: once.value ? new Date(once.value).toISOString() : ''}
        case 'cron': return {kind: 'cron', cron: cron.value}
        default: return {kind: kind.value, time: time.value}
    }
})
const cronText = computed(() => toCron(repeat.value))
const atText = computed(() => repeat.value.kind === 'once' ? repeat.value.at : null)
const upcoming = computed(() => nextTimes(cronText.value, atText.value, timezone.value))
const ready = computed(() => !!project.value && !!title.value.trim() && (sends.value === 'issue' || !!notes.value.trim())
    && upcoming.value.length > 0 && !saving.value)

function toggleDay(d: number) {
    days.value = days.value.includes(d) ? days.value.filter(x => x !== d) : [...days.value, d]
}

function close() {
    editing.value = null
}

async function save() {
    if (!ready.value) return
    saving.value = true
    failed.value = ''
    const body = {
        kind: sends.value,
        title: title.value.trim(),
        notes: notes.value.trim() || null,
        ...cronText.value ? {cron: cronText.value} : {at: atText.value},
        timezone: timezone.value,
        column: column.value,
        chunk: chunk.value || null,
        priority: priority.value || null,
        labels: labels.value,
        ask: ask.value,
        skip_open: skipOpen.value,
    }
    try {
        const base = `/api/projects/${encodeURIComponent(project.value)}/schedules`
        const headers = {'Orrery-Actor': await load()}
        if (existing.value) await $fetch<Schedule>(`${base}/${existing.value.id}`, {method: 'PATCH', headers, body})
        else await $fetch<Schedule>(base, {method: 'POST', headers, body})
        close()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}

async function togglePause() {
    if (!existing.value || pausing.value) return
    pausing.value = true
    failed.value = ''
    try {
        await pause(existing.value, enabled.value)
        enabled.value = !enabled.value
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        pausing.value = false
    }
}

const field = 'h-8 field'
</script>

<template>
  <UiDialog :open="editing" :label="existing ? 'Edit schedule' : 'New schedule'" width="2xl" @close="close" @submit="save">
    <div class="flex items-center gap-2 text-xs text-faint">
      <SectionIcon section="schedules" />
      <span>{{ existing ? 'Edit schedule in' : 'New schedule in' }}</span>
      <span class="text-fg">{{ here?.name ?? project }}</span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>

    <SegmentedControl v-model="sends" :options="SENDS" class="self-start" />
    <input
        ref="titleInput"
        v-model="title"
        :placeholder="sends === 'issue' ? 'What to do, e.g. Groom the backlog' : 'Its name, e.g. Check CI'"
        aria-label="Title"
        class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none"
    >
    <textarea
        v-model="notes"
        rows="3"
        :placeholder="sends === 'issue' ? 'Instructions for each run… (Markdown works; it\'s the issue\'s description)' : 'The message the sessions get each run, e.g. Check CI on main; if it\'s red, tell me why'"
        :aria-label="sends === 'issue' ? 'Instructions' : 'Message'"
        class="resize-y bg-transparent text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
    />

    <section class="flex flex-col gap-2 border-t border-line pt-3">
      <span class="label">When</span>
      <div class="flex flex-wrap items-center gap-2">
        <PropertyPicker v-model="kind" :options="KINDS" label="Repeats" field>
          <span class="truncate">{{ label(KINDS, kind) }}</span>
        </PropertyPicker>
        <template v-if="['daily', 'weekdays', 'weekly', 'monthly'].includes(kind)">
          <template v-if="kind === 'monthly'">
            <span class="text-xs text-muted">on day</span>
            <input v-model.number="day" type="number" min="1" max="31" aria-label="Day of the month" :class="[field, 'w-16']">
          </template>
          <span class="text-xs text-muted">at</span>
          <input v-model="time" type="time" aria-label="Time" :class="field">
        </template>
        <template v-else-if="kind === 'minutes'">
          <span class="text-xs text-muted">every</span>
          <PropertyPicker v-model="everyMinutesPicked" :options="MINUTES" label="Every how many minutes" field>
            <span class="truncate">{{ label(MINUTES, everyMinutesPicked) }}</span>
          </PropertyPicker>
        </template>
        <template v-else-if="kind === 'hours'">
          <span class="text-xs text-muted">every</span>
          <PropertyPicker v-model="everyPicked" :options="HOURS" label="Every how many hours" field>
            <span class="truncate">{{ label(HOURS, everyPicked) }}</span>
          </PropertyPicker>
          <span class="text-xs text-muted">at minute</span>
          <input v-model.number="minute" type="number" min="0" max="59" aria-label="Minute" :class="[field, 'w-16']">
        </template>
        <input v-else-if="kind === 'once'" v-model="once" type="datetime-local" aria-label="When" :class="field">
        <input v-else v-model="cron" placeholder="minute hour day month weekday" aria-label="Cron" :class="[field, 'w-52 font-mono']">
      </div>
      <div v-if="kind === 'weekly'" class="flex gap-1">
        <button
            v-for="d in [1, 2, 3, 4, 5, 6, 0]"
            :key="d"
            type="button"
            class="h-7 w-10 rounded-md text-xs ring-1"
            :class="days.includes(d) ? 'bg-accent-500/15 font-medium text-accent-700 ring-accent-500/40 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover'"
            :aria-pressed="days.includes(d)"
            @click="toggleDay(d)"
        >{{ DAYS[d] }}</button>
      </div>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
        <template v-if="upcoming.length">
          <span>Next:</span>
          <span v-for="t in upcoming" :key="t.toISOString()" class="rounded bg-well px-1.5 py-px text-muted ring-1 ring-line">{{ when(t, timezone) }}</span>
        </template>
        <span v-else class="text-rose-600 dark:text-rose-400">{{ kind === 'once' ? 'Pick a time that hasn’t passed' : 'That doesn’t give a time yet' }}</span>
        <label class="ml-auto flex items-center gap-1">
          <span>Timezone</span>
          <input v-model="timezone" aria-label="Timezone" class="h-6 w-36 rounded-md bg-well px-1.5 text-xs text-fg ring-1 ring-line focus:outline-none">
        </label>
      </p>
    </section>

    <p v-if="sends === 'message'" class="border-t border-line pt-3 text-xs text-muted">
      Each run sends this to {{ here?.name ?? 'the project' }}'s listening Claude sessions, with no issue. If none is listening, the next one to connect within a day gets it.
    </p>
    <section v-else class="flex flex-col gap-2 border-t border-line pt-3">
      <span class="label">Each run makes an issue</span>
      <div class="flex flex-wrap items-center gap-2">
        <PropertyPicker v-model="column" :options="startOptions" label="Where it starts" field up>
          <StatusIcon :column="column" />
          <span class="truncate">{{ label(startOptions, column) }}</span>
          <template #option="{option}">
            <StatusIcon :column="option.value" />
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          </template>
        </PropertyPicker>
        <PropertyPicker v-model="priority" :options="PRIORITY_OPTIONS" label="Priority" field up>
          <PriorityIcon :priority="priority || undefined" />
          <span class="truncate" :class="!priority && 'text-muted'">{{ label(PRIORITY_OPTIONS, priority) }}</span>
          <template #option="{option}">
            <PriorityIcon :priority="option.value || undefined" />
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          </template>
        </PropertyPicker>
        <PropertyPicker v-model="chunk" :options="chunkOptions" label="Chunk" field up>
          <span class="truncate" :class="!chunk && 'text-muted'">{{ label(chunkOptions, chunk) }}</span>
        </PropertyPicker>
        <LabelPicker v-model="labels" :labels="known" />
      </div>
      <label class="flex items-center gap-1.5 text-xs text-muted">
        <input v-model="ask" type="checkbox" class="accent-accent-500">
        Ask {{ here?.name ?? 'the project' }}'s Claude sessions to pick it up (if none is listening, the next one to connect gets it)
      </label>
      <label class="flex items-center gap-1.5 text-xs text-muted">
        <input v-model="skipOpen" type="checkbox" class="accent-accent-500">
        Skip a run while the last run's issue isn't done
      </label>
    </section>

    <div class="flex items-center gap-2 border-t border-line pt-3">
      <UiButton v-if="existing && !(existing.at && !existing.enabled)" size="md" :disabled="pausing" @click="togglePause">
        {{ enabled ? '❙❙ Pause' : '▶ Resume' }}
      </UiButton>
      <span v-if="!enabled" class="text-xs text-faint">Paused: it won't run until you resume it</span>
      <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="!ready">
        {{ saving ? 'Saving…' : existing ? 'Save schedule' : 'Create schedule' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
      </UiButton>
    </div>
  </UiDialog>
</template>
