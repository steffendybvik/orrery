<script setup lang="ts">
import type {Preset, Project} from '#shared/roadmap'

// Presets: saved pieces of context to give a session as you start it, each a name and its text. On the Sessions page
// they're the Orrery's, for sessions on any project; with `project`, that project's own. Each is a role card: its
// badge, name and first line; clicking one opens it to change in place (saved on leaving the field, or as the badge
// is picked). New preset is an empty card that opens the form.
const props = defineProps<{project?: Project}>()
const {load} = useOwner()
const {forget} = usePresetBadges()
const failed = ref('')

const presets = ref<Preset[]>([])
const list = computed(() => props.project ? `/api/projects/${encodeURIComponent(props.project.id)}/presets` : '/api/presets')
async function refresh() {
    const all = await $fetch<Preset[]>(list.value).catch(() => null)
    if (all) presets.value = all.filter(p => p.project === (props.project?.id ?? null))
}
watch(list, refresh, {immediate: true})

async function write(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, string | null | undefined>) {
    failed.value = ''
    try {
        await $fetch(url, {method, headers: {'Orrery-Actor': await load()}, body})
        await refresh()
        forget()
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        return false
    }
}

const editing = ref<number | null>(null)
const opened = ref(false)
const adding = reactive({name: '', text: ''})
async function add() {
    if (!adding.name.trim() || !adding.text.trim()) return
    if (await write(list.value, 'POST', {...adding})) {
        adding.name = adding.text = ''
        opened.value = false
    }
}
function change(preset: Preset, key: 'name' | 'text', event: Event) {
    const field = event.target as HTMLInputElement | HTMLTextAreaElement
    const value = field.value.trim()
    if (!value) field.value = preset[key]
    else if (value !== preset[key]) write(`/api/presets/${preset.id}`, 'PATCH', {[key]: value})
}
const badge = (preset: Preset, change: {icon?: string | null, color?: string | null}) => write(`/api/presets/${preset.id}`, 'PATCH', change)
const remove = (preset: Preset) => write(`/api/presets/${preset.id}`, 'DELETE')

const line = 'h-8 min-w-0 flex-1 field'
const area = 'w-full field py-2 leading-5'
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul class="grid gap-2 sm:grid-cols-2">
      <li
          v-for="p in presets"
          :key="p.id"
          class="flex flex-col rounded-xl border transition-colors"
          :class="editing === p.id ? 'col-span-full border-accent-500/40' : 'border-line hover:bg-hover'"
      >
        <button
            type="button"
            class="flex min-w-0 items-center gap-3 rounded-xl p-3 text-left"
            :aria-expanded="editing === p.id"
            :aria-label="`${editing === p.id ? 'Done editing' : 'Edit'} ${p.name}`"
            @click="editing = editing === p.id ? null : p.id"
        >
          <PresetBadge :preset="p" :size="32" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[13px] font-medium text-fg">{{ p.name }}</span>
            <span class="truncate text-xs text-muted">{{ firstLine(p.text) }}</span>
          </span>
          <span v-if="editing === p.id" class="shrink-0 text-xs text-faint">Done</span>
        </button>
        <div v-if="editing === p.id" class="flex flex-col gap-1.5 border-t border-line/60 p-3">
          <input :value="p.name" :class="line" aria-label="Preset name" @blur="change(p, 'name', $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
          <textarea :value="p.text" rows="3" :class="area" :aria-label="`What ${p.name} tells a session`" @blur="change(p, 'text', $event)" />
          <span class="label mt-1.5 px-1">Badge <span class="font-normal normal-case text-faint">· without an icon, its initials</span></span>
          <IconPicker :icon="p.icon" :color="p.color" label="Badge" @change="picked => badge(p, picked)">
            <UiButton v-if="p.icon" size="xs" class="self-start" @click="badge(p, {icon: null})">Use its initials</UiButton>
          </IconPicker>
          <div class="flex justify-end">
            <UiButton variant="danger-ghost" size="sm" @click="remove(p)">Remove {{ p.name }}</UiButton>
          </div>
        </div>
      </li>
      <li v-if="presets.length && !opened">
        <button
            type="button"
            class="flex size-full min-h-[58px] items-center gap-3 rounded-xl border border-dashed border-line p-3 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
            @click="opened = true"
        >
          <span class="grid size-8 place-items-center rounded-[28%] ring-1 ring-inset ring-line">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          New preset
        </button>
      </li>
    </ul>
    <form v-if="opened || !presets.length" class="flex flex-col gap-1.5" @submit.prevent="add">
      <input v-model="adding.name" :class="line" placeholder="Name, e.g. Review" aria-label="New preset name">
      <textarea
          v-model="adding.text"
          rows="3"
          :class="area"
          :placeholder="project ? `What it tells a session on ${project.name}, e.g. run the e2e suite before you finish` : 'What it tells a session, e.g. you\'re reviewing: read the diff and comment, don\'t change code'"
          aria-label="New preset text"
          @keydown.meta.enter.prevent="add"
          @keydown.ctrl.enter.prevent="add"
      />
      <div class="flex justify-end gap-2">
        <UiButton v-if="presets.length" variant="ghost" size="md" @click="opened = false">Cancel</UiButton>
        <UiButton type="submit" size="md" :disabled="!adding.name.trim() || !adding.text.trim()">Add preset</UiButton>
      </div>
    </form>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
