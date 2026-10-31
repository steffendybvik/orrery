<script setup lang="ts">
import type {Instruction} from '#shared/prompt'
import type {Project} from '#shared/roadmap'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT, PLACEHOLDERS, renderPrompt} from '#shared/prompt'

// What a Claude session hears when asked to focus: the two templates (an issue, a chunk's issues) and the
// standing instructions added to every focus. Without `project` they're the orrery's (every project's); with it, that
// project's own templates (empty follows the orrery's), its own instructions, and the orrery's it switches off.
// Each template shows what it's for and whose it is; its text opens with Edit.
const props = defineProps<{project?: Project}>()
const {settings, save: saveSettings} = useAppSettings()
const failed = ref('')

const KINDS = [
    {key: 'focus_prompt', label: 'Focus on an issue', about: 'What a session hears when you ask it to work on one issue.', fallback: DEFAULT_FOCUS_PROMPT, placeholders: PLACEHOLDERS.focus},
    {key: 'chunk_prompt', label: "Work through a chunk's issues", about: "What a session hears when you ask it to work through a chunk's or a release's issues.", fallback: DEFAULT_CHUNK_PROMPT, placeholders: PLACEHOLDERS.chunk},
] as const
type Key = (typeof KINDS)[number]['key']

/** What a template follows when left empty: the orrery's for a project, else the default. */
const inherited = (key: Key) => (props.project ? settings.value[key] : null) ?? KINDS.find(k => k.key === key)?.fallback ?? ''
const saved = (key: Key) => (props.project ? props.project[key] : settings.value[key]) ?? ''
const drafts = reactive<Record<Key, string>>({focus_prompt: '', chunk_prompt: ''})
watch(() => [saved('focus_prompt'), saved('chunk_prompt')] as const, ([focus, chunk]) => {
    drafts.focus_prompt = focus
    drafts.chunk_prompt = chunk
}, {immediate: true})

async function save(change: Record<string, unknown>) {
    failed.value = ''
    try {
        if (props.project) {
            await apiFetch(`/projects/${encodeURIComponent(props.project.id)}`, {method: 'PATCH', body: change})
        } else {
            await saveSettings(change as Partial<typeof settings.value>)
        }
    } catch (error) {
        failed.value = errorMessage(error)
    }
}

function saveTemplate(key: Key) {
    if (drafts[key].trim() !== saved(key).trim()) save({[key]: drafts[key].trim() || null})
}

function reset(key: Key) {
    drafts[key] = ''
    save({[key]: null})
}

// The preview: the template as a session would hear it, for a made-up issue or chunk.
const own = computed(() => props.project?.instructions ?? settings.value.instructions)
const ticked = computed(() => [
    ...settings.value.instructions.filter(i => i.on && !(props.project?.muted ?? []).includes(i.id)),
    ...props.project ? props.project.instructions.filter(i => i.on) : [],
].map(i => i.text))
const SAMPLE = {
    focus_prompt: {actor: 'you', issue: 'GRE-42', title: 'Scale a recipe by servings', status: 'Todo', priority: 'P1', chunk: 'Recipes', where: 'Todo, P1, Recipes', note: 'before the weekend', url: 'http://localhost:9000/api/projects/greenhouse/issues/GRE-42'},
    chunk_prompt: {
        actor: 'you', chunk: '3', title: 'Recipes', status: 'Todo', priority: 'P2', where: 'Todo, P2', note: '',
        issues: '- GRE-42: Scale a recipe by servings [Todo, P1]\n- GRE-43: Timers inside steps [Todo]', url: 'http://localhost:9000/api/projects/greenhouse/chunks/3',
    },
}
const preview = (key: Key) => renderPrompt(drafts[key].trim() || inherited(key), SAMPLE[key], ticked.value)
const showing = ref<Key | null>(null)
const editing = ref<Key | null>(null)
/** Whose template a session hears now. */
const whose = (key: Key) => saved(key) ? (props.project ? `${props.project.name}'s own` : 'your own') : (props.project ? "the orrery's" : 'the default')
function edit(key: Key) {
    if (editing.value === key) saveTemplate(key)
    editing.value = editing.value === key ? null : key
}

// The standing instructions: added, edited in place (saved on leaving the field), ticked by default or not, removed.
const adding = ref('')
function saveLines(lines: Instruction[]) {
    save({instructions: lines})
}
function add() {
    const text = adding.value.trim()
    if (!text) return
    saveLines([...own.value, {text, on: true} as Instruction])
    adding.value = ''
}
function rename(line: Instruction, event: Event) {
    const text = (event.target as HTMLInputElement).value.trim()
    if (!text) (event.target as HTMLInputElement).value = line.text
    else if (text !== line.text) saveLines(own.value.map(l => l.id === line.id ? {...l, text} : l))
}
const toggle = (line: Instruction) => saveLines(own.value.map(l => l.id === line.id ? {...l, on: !l.on} : l))
const remove = (line: Instruction) => saveLines(own.value.filter(l => l.id !== line.id))
/** On a project, one of the orrery's instructions switched on or off for it. */
function mute(line: Instruction) {
    if (!props.project) return
    const muted = props.project.muted
    save({muted: muted.includes(line.id) ? muted.filter(id => id !== line.id) : [...muted, line.id]})
}

const field = 'w-full rounded-lg bg-well px-2.5 py-2 font-mono text-[12px] leading-5 text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
const line = 'h-8 min-w-0 flex-1 field'
</script>

<template>
  <div class="flex flex-col gap-5">
    <div v-for="kind in KINDS" :key="kind.key" class="flex flex-col gap-1.5">
      <div class="flex items-start gap-2">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 class="flex items-baseline gap-2 text-[13px] font-medium text-fg">
            {{ kind.label }}
            <span class="text-xs font-normal text-faint">{{ whose(kind.key) }}</span>
          </h3>
          <p class="text-xs text-muted">{{ kind.about }}</p>
        </div>
        <UiButton variant="ghost" size="xs" class="shrink-0" :aria-expanded="showing === kind.key" @click="showing = showing === kind.key ? null : kind.key">
          {{ showing === kind.key ? 'Hide preview' : 'Preview' }}
        </UiButton>
        <UiButton size="xs" class="shrink-0" :aria-expanded="editing === kind.key" :aria-label="`${editing === kind.key ? 'Done editing' : 'Edit'} ${kind.label}`" @click="edit(kind.key)">
          {{ editing === kind.key ? 'Done' : 'Edit' }}
        </UiButton>
      </div>
      <template v-if="editing === kind.key">
        <textarea
            v-model="drafts[kind.key]"
            rows="4"
            :placeholder="inherited(kind.key)"
            :aria-label="kind.label"
            :class="field"
            @blur="saveTemplate(kind.key)"
        />
        <p class="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-faint">
          <span v-for="(what, name) in kind.placeholders" :key="name" :title="what" class="font-mono">{{ '{' + name + '}' }}</span>
          <span>· a line whose placeholders are all empty is left out</span>
          <button v-if="saved(kind.key)" type="button" class="ml-auto underline-offset-2 hover:text-fg hover:underline" @click="reset(kind.key)">
            Reset to {{ project ? "the orrery's" : 'the default' }}
          </button>
        </p>
      </template>
      <pre v-if="showing === kind.key" class="rounded-lg bg-well/60 px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-muted ring-1 ring-line">{{ preview(kind.key) }}</pre>
    </div>

    <div class="flex flex-col gap-2 border-t border-line/60 pt-5">
      <div class="flex flex-col gap-0.5">
        <h3 class="text-[13px] font-medium text-fg">Standing instructions</h3>
        <p class="text-xs text-muted">
          Lines added to every focus, such as "commit whenever a piece works". Ticked ones go by default; the focus panel lets you
          change that for one send.<template v-if="project"> Every project's are under Every project; switch them off for this one here.</template>
        </p>
      </div>

      <ul v-if="project && settings.instructions.length" class="flex flex-col gap-1">
        <li v-for="l in settings.instructions" :key="l.id" class="flex items-center gap-2 text-[13px]">
          <input
              type="checkbox"
              class="size-3.5 accent-accent-500"
              :checked="!project.muted.includes(l.id)"
              :aria-label="`Use “${l.text}” in ${project.name}`"
              @change="mute(l)"
          >
          <span :class="project.muted.includes(l.id) ? 'text-faint line-through' : 'text-muted'">{{ l.text }}</span>
          <span v-if="!l.on" class="text-[11px] text-faint">unticked by default</span>
        </li>
      </ul>

      <ul class="flex flex-col gap-1.5">
        <li v-for="l in own" :key="l.id" class="flex items-center gap-2">
          <input type="checkbox" class="size-3.5 accent-accent-500" :checked="l.on" :title="l.on ? 'Ticked by default' : 'Unticked by default'" :aria-label="`Tick “${l.text}” by default`" @change="toggle(l)">
          <input :value="l.text" :class="line" aria-label="Instruction" @blur="rename(l, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
          <UiButton variant="danger-ghost" square class="shrink-0" :aria-label="`Remove “${l.text}”`" @click="remove(l)">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </UiButton>
        </li>
      </ul>
      <form class="flex items-center gap-2" @submit.prevent="add">
        <input v-model="adding" :class="line" :placeholder="project ? `A line for ${project.name}'s sessions only` : 'Create a new branch for this'" aria-label="New instruction">
        <UiButton type="submit" size="md" class="shrink-0" :disabled="!adding.trim()">Add</UiButton>
      </form>
    </div>

    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
