<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// Moving a whole workspace to another orrery, or one of another's here (ORR-1249), as `pnpm orrery:import` does from a
// checkout (ORR-1110), without files or a command line. This server does it: this orrery as the page's own requests, the
// other with its owner's key, which goes no further than the move. A preview first, writing nothing; then the move, followed
// as it goes; then, after a send, each board here can be marked as moved (ORR-1225), so this copy only reads.
type Direction = 'send' | 'bring'
interface Planned {from: string, id: string, key: string, name: string, skipped?: boolean, error?: string}
interface Report {workspace?: {id: string, name: string}, projects?: Planned[]}
interface Move {state: 'running' | 'done' | 'failed', progress?: {step: string, project?: string, done: number, total: number}, lines: string[], summary?: string, report?: Report, error?: string}
interface Remote {id: string, name: string, role?: string}

const field = 'h-8 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
const {shared, owner, me} = usePeople()
const isOwner = computed(() => !owner.value || me.value === owner.value)
const {current} = useWorkspaces()

const direction = ref<Direction>('send')
const directions: {value: Direction, label: string}[] = [{value: 'send', label: 'Send this workspace'}, {value: 'bring', label: 'Bring one in'}]
const url = ref('')
const key = ref('')
const name = ref('')
const from = ref('default')
const color = ref('')
const add = ref(false)
const enableSchedules = ref(false)
const remotes = ref<Remote[]>([])

const previewing = ref(false)
const preview = ref<{summary: string, report: Report} | null>(null)
const moving = ref(false)
const move = ref<Move | null>(null)
const failed = ref('')
const marked = ref<string[]>([])
const marking = ref(false)

// A send names the workspace after this one, unless you've named it.
watch(current, now => {
    if (now && !name.value) name.value = now.name
}, {immediate: true})
// Anything changed makes the preview old.
watch([direction, url, key, name, from, color, add, enableSchedules], () => {
    preview.value = null
    failed.value = ''
})
watch(direction, () => {
    remotes.value = []
    name.value = direction.value === 'send' ? current.value?.name ?? '' : ''
})

const ask = () => ({
    direction: direction.value, url: url.value.trim(), key: key.value.trim(), name: name.value.trim(),
    ...direction.value === 'bring' ? {from: from.value} : {},
    ...color.value ? {color: color.value} : {}, add: add.value, enableSchedules: enableSchedules.value,
})

/** On a bring, the other orrery's workspaces, to choose which comes. */
async function lookUp() {
    if (direction.value !== 'bring' || !url.value.trim()) return
    failed.value = ''
    try {
        remotes.value = await apiFetch<Remote[]>('/orrery-moves/workspaces', {method: 'POST', body: {url: url.value.trim(), key: key.value.trim()}})
        const first = remotes.value.find(w => w.id === 'default') ?? remotes.value[0]
        if (first) {
            from.value = first.id
            if (!name.value) name.value = first.name
        }
    } catch (error) {
        remotes.value = []
        failed.value = errorMessage(error, 'reach')
    }
}
watch(from, id => {
    const chosen = remotes.value.find(w => w.id === id)
    if (chosen && direction.value === 'bring') name.value = chosen.name
})

async function check() {
    previewing.value = true
    failed.value = ''
    move.value = null
    try {
        preview.value = await apiFetch<{summary: string, report: Report}>('/orrery-moves', {method: 'POST', body: {...ask(), dryRun: true}})
    } catch (error) {
        failed.value = errorMessage(error, 'check')
    } finally {
        previewing.value = false
    }
}

let timer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(timer))
async function go() {
    moving.value = true
    failed.value = ''
    marked.value = []
    try {
        const {id} = await apiFetch<{id: string}>('/orrery-moves', {method: 'POST', body: ask()})
        move.value = {state: 'running', lines: []}
        preview.value = null
        await follow(id)
    } catch (error) {
        failed.value = errorMessage(error, 'start')
    } finally {
        moving.value = false
    }
}
async function follow(id: string) {
    for (;;) {
        try {
            move.value = await apiFetch<Move>(`/orrery-moves/${id}`)
        } catch (error) {
            move.value = {state: 'failed', lines: move.value?.lines ?? [], error: errorMessage(error)}
            return
        }
        if (move.value.state !== 'running') return
        await new Promise(resolve => { timer = setTimeout(resolve, 1000) })
    }
}

const progress = computed(() => {
    const p = move.value?.progress
    if (!p) return 'Starting…'
    if (p.step === 'reading') return `Reading ${p.done + 1} of ${p.total} boards…`
    if (p.step === 'uploading') return `Moving ${p.done + 1} of ${p.total} boards${p.project ? ` (${p.project})` : ''}…`
    return 'Putting schedules, links and epics back…'
})
const remoteBase = computed(() => url.value.trim().replace(/\/+$/, ''))
const arrived = computed(() => (move.value?.report?.projects ?? []).filter(p => !p.skipped && !p.error))
const where = computed(() => {
    const ws = move.value?.report?.workspace
    return ws && direction.value === 'send' ? `${remoteBase.value}${inWorkspace(ws.id, '/mine')}` : undefined
})

/** After a send, each board that arrived is marked as moved here, pointing at its new page. */
async function markAll() {
    const ws = move.value?.report?.workspace
    if (!ws) return
    marking.value = true
    failed.value = ''
    try {
        for (const p of arrived.value) {
            if (marked.value.includes(p.from)) continue
            await apiFetch(`/projects/${encodeURIComponent(p.from)}/moved`, {method: 'PUT', body: {to: `${remoteBase.value}${inWorkspace(ws.id, `/p/${p.id}`)}`}})
            marked.value.push(p.from)
        }
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        marking.value = false
    }
}
</script>

<template>
  <p v-if="!isOwner" class="text-xs text-muted">Only {{ shared ? 'this orrery\'s owner' : 'the owner' }} moves a workspace.</p>
  <div v-else class="flex flex-col gap-3">
    <SegmentedControl v-model="direction" :options="directions" class="self-start" aria-label="Which way" />
    <form class="flex flex-col gap-2" @submit.prevent="check">
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span>{{ direction === 'send' ? 'To the orrery at' : 'From the orrery at' }}</span>
          <input v-model="url" type="url" required placeholder="https://orrery.example.com" autocomplete="off" spellcheck="false" :class="[field, 'w-72 font-mono']" @change="lookUp">
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span>Its owner's key</span>
          <input v-model="key" type="password" autocomplete="off" spellcheck="false" placeholder="orrery_person_…" :class="[field, 'w-64 font-mono']" @change="lookUp">
        </label>
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <label v-if="direction === 'bring' && remotes.length" class="flex flex-col gap-1 text-xs text-muted">
          <span>Its workspace</span>
          <select v-model="from" :class="[field, 'w-48']">
            <option v-for="w in remotes" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span>{{ add ? 'Add to the workspace there named' : 'As a new workspace named' }}</span>
          <input v-model="name" required maxlength="60" autocomplete="off" :class="[field, 'w-48']">
        </label>
        <label v-if="!add" class="flex flex-col gap-1 text-xs text-muted">
          <span>Colour</span>
          <select v-model="color" :class="[field, 'w-32']">
            <option value="">As it is</option>
            <option v-for="t in TINTS" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
      </div>
      <label class="flex items-center gap-2 text-[13px] text-fg"><input v-model="add" type="checkbox"> Add to a workspace it already has</label>
      <label class="flex items-center gap-2 text-[13px] text-fg"><input v-model="enableSchedules" type="checkbox" :disabled="add"> Turn on the schedules that were on (otherwise they arrive paused)</label>
      <p class="text-xs text-muted">
        The {{ direction === 'send' ? 'workspace here' : 'other orrery' }} isn't changed. The key is a person key of the other orrery's owner (App settings → You → Your keys there; none when it has no login), and is used for this move only.
      </p>
      <div class="flex gap-2">
        <UiButton type="submit" :disabled="previewing || moving"><UiBusy :busy="previewing" label="Checking…">Preview</UiBusy></UiButton>
      </div>
    </form>

    <div v-if="preview" class="flex flex-col gap-2">
      <pre class="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-well p-3 font-mono text-xs text-fg ring-1 ring-line">{{ preview.summary }}</pre>
      <div class="flex gap-2">
        <UiButton variant="primary" :disabled="moving" @click="go"><UiBusy :busy="moving" label="Moving…">Move it</UiBusy></UiButton>
        <UiButton variant="ghost" :disabled="moving" @click="preview = null">Cancel</UiButton>
      </div>
    </div>

    <div v-if="move" role="status" class="flex flex-col gap-2">
      <p v-if="move.state === 'running'" class="flex items-center gap-2 text-[13px] text-fg"><UiSpinner /> {{ progress }}</p>
      <p v-else-if="move.state === 'failed'" class="text-xs text-rose-700 dark:text-rose-400">The move stopped: {{ move.error }}</p>
      <p v-else class="text-[13px] text-fg">
        Moved.
        <a v-if="where" :href="where" target="_blank" rel="noopener" class="underline underline-offset-2">Open it there</a>
      </p>
      <pre v-if="move.summary || move.lines.length" class="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-well p-3 font-mono text-xs text-fg ring-1 ring-line">{{ move.summary ?? move.lines.join('\n') }}</pre>
      <div v-if="move.state === 'done' && direction === 'send' && arrived.length" class="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span v-if="marked.length === arrived.length">Each board here is marked as moved, and only reads.</span>
        <template v-else>
          <span>Mark the {{ arrived.length }} board{{ arrived.length === 1 ? '' : 's' }} here as moved, so they only read and point there?</span>
          <UiButton size="sm" :disabled="marking" @click="markAll"><UiBusy :busy="marking" label="Marking…">Mark as moved</UiBusy></UiButton>
        </template>
      </div>
    </div>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
