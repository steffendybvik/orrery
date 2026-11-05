<script setup lang="ts">
import type {Effort, Settings, WorkKind} from '#shared/roadmap'
import {EFFORTS, MODEL_ALIASES, WORK_KINDS, isModel, slugify} from '#shared/roadmap'

// Sessions → Setup → Models (ORR-869): the kinds of work, highest-ranked first, and the model and effort a session for
// each starts on. An issue's kind is its highest-ranked label's, so the order matters: a lighter model never gets work
// that also carries a heavier label. Kept as `work_kinds` in the orrery's settings; each change saves the whole list.
const {settings, save} = useAppSettings()
const failed = ref('')
const saving = ref(false)

/** What's on screen: the saved kinds, labels as typed text, until a change is saved. */
type Row = Omit<WorkKind, 'labels'> & {labels: string}
const toRows = (kinds: readonly WorkKind[]): Row[] => kinds.map(k => ({...k, labels: k.labels.join(', ')}))
const rows = ref<Row[]>(toRows(settings.value.work_kinds))
watch(() => settings.value.work_kinds, kinds => {
    rows.value = toRows(kinds)
})

const isDefault = computed(() => JSON.stringify(settings.value.work_kinds) === JSON.stringify(WORK_KINDS))

async function store(kinds: WorkKind[] | null) {
    failed.value = ''
    saving.value = true
    try {
        // Reset is null on the server, so orrery's own kinds follow it as they change; the page shows them at once.
        if (kinds) await save({work_kinds: kinds})
        else settings.value = await apiFetch<Settings>('/settings', {method: 'PATCH', body: {work_kinds: null}})
    } catch (error) {
        failed.value = errorMessage(error)
        rows.value = toRows(settings.value.work_kinds)
    } finally {
        saving.value = false
    }
}

/** Saves what's on screen, once each kind has a name and a model orrery takes. */
function commit() {
    const bad = rows.value.find(r => !r.name.trim() || !isModel(r.model.trim()))
    if (bad) {
        failed.value = !bad.name.trim() ? 'Each kind needs a name.' : `${bad.name}'s model should be ${MODEL_ALIASES.join(', ')}, or a full id such as claude-sonnet-5-5.`
        return
    }
    void store(rows.value.map(({labels, effort, ...k}) => ({
        ...k,
        name: k.name.trim(),
        model: k.model.trim(),
        labels: labels.split(',').map(l => l.trim().toLowerCase()).filter(Boolean),
        ...effort ? {effort} : {},
    })))
}

function move(index: number, by: -1 | 1) {
    const to = index + by
    if (to < 0 || to >= rows.value.length) return
    const next = rows.value.filter((_, i) => i !== index)
    next.splice(to, 0, rows.value[index] as Row)
    rows.value = next
    commit()
}

function remove(index: number) {
    rows.value = rows.value.filter((_, i) => i !== index)
    commit()
}

const newName = ref('')
function add() {
    const name = newName.value.trim()
    if (!name) return
    const base = slugify(name) || 'kind'
    let id = base
    for (let n = 2; rows.value.some(r => r.id === id); n++) id = `${base}-${n}`
    // A new kind goes above Other, which takes what no label matches.
    const other = rows.value.findIndex(r => r.id === 'other')
    const at = other < 0 ? rows.value.length : other
    rows.value = [...rows.value.slice(0, at), {id, name, labels: slugify(name), model: 'best'}, ...rows.value.slice(at)]
    newName.value = ''
    commit()
}

const field = 'h-8 field'
const effortOf = (value: string): Effort | undefined => (EFFORTS as readonly string[]).includes(value) ? value as Effort : undefined
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="work-kinds">
    <div class="flex items-baseline gap-3">
      <h3 class="text-[13px] font-semibold text-fg">Models</h3>
      <button v-if="!isDefault" type="button" class="text-xs text-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-50" :disabled="saving" @click="store(null)">
        Reset to orrery's defaults
      </button>
    </div>
    <p class="text-xs text-faint">
      The model a session starts on for each kind of work. An issue's kind is its highest-ranked label's, so order them
      heaviest first. <span class="font-mono">best</span> is Claude Code's own pick. Roadmap is the Roadmap tidy schedule's,
      Other is anything no label matches, and Chat is your chat.
    </p>
    <datalist id="work-kind-models">
      <option v-for="alias in MODEL_ALIASES" :key="alias" :value="alias" />
    </datalist>
    <ol class="flex flex-col gap-1.5">
      <li v-for="(row, index) in rows" :key="row.id" class="flex flex-wrap items-center gap-2" :data-kind="row.id">
        <span class="w-5 text-right font-mono text-[11px] text-faint tabular-nums">{{ index + 1 }}</span>
        <input v-model="row.name" :aria-label="`Name of ${row.name || 'this kind'}`" :class="[field, 'w-32']" @change="commit()">
        <input
            v-model="row.labels"
            :aria-label="`${row.name}'s labels`"
            :placeholder="row.id === 'other' || row.id === 'chat' || row.id === 'roadmap' ? 'no labels' : 'labels, comma-separated'"
            :class="[field, 'w-56 min-w-0 flex-1']"
            @change="commit()"
        >
        <input v-model="row.model" list="work-kind-models" :aria-label="`${row.name}'s model`" :class="[field, 'w-36 font-mono']" @change="commit()">
        <select :value="row.effort ?? ''" :aria-label="`${row.name}'s effort`" :class="[field, 'w-36']" @change="row.effort = effortOf(($event.target as HTMLSelectElement).value); commit()">
          <option value="">default effort</option>
          <option v-for="effort in EFFORTS" :key="effort" :value="effort">{{ effort }}</option>
        </select>
        <span class="flex items-center gap-0.5">
          <button type="button" class="grid size-7 place-items-center rounded text-faint hover:bg-hover hover:text-fg disabled:opacity-30" :disabled="index === 0 || saving" :aria-label="`Move ${row.name} up`" @click="move(index, -1)">↑</button>
          <button type="button" class="grid size-7 place-items-center rounded text-faint hover:bg-hover hover:text-fg disabled:opacity-30" :disabled="index === rows.length - 1 || saving" :aria-label="`Move ${row.name} down`" @click="move(index, 1)">↓</button>
          <button type="button" class="grid size-7 place-items-center rounded text-faint hover:bg-hover hover:text-rose-700 disabled:opacity-30" :disabled="rows.length === 1 || saving" :aria-label="`Remove ${row.name}`" @click="remove(index)">×</button>
        </span>
      </li>
    </ol>
    <form class="flex items-center gap-2 pl-7" @submit.prevent="add()">
      <input v-model="newName" placeholder="A new kind's name" aria-label="A new kind's name" :class="[field, 'w-48']">
      <button type="submit" class="h-8 rounded-md px-2.5 text-xs font-medium text-muted ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50" :disabled="!newName.trim() || saving">Add kind</button>
    </form>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
