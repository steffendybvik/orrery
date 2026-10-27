<script setup lang="ts">
import type {Preset, Project} from '#shared/roadmap'

// Presets: saved pieces of context to give a session as you start it, each a name and its text. On the Sessions page
// they're the Orrery's, for sessions on any project; with `project`, that project's own. Each is a row with its
// name and first line; Edit opens it to change in place (saved on leaving the field). New preset opens the form.
const props = defineProps<{project?: Project}>()
const {load} = useOwner()
const failed = ref('')

const presets = ref<Preset[]>([])
const list = computed(() => props.project ? `/api/projects/${encodeURIComponent(props.project.id)}/presets` : '/api/presets')
async function refresh() {
    const all = await $fetch<Preset[]>(list.value).catch(() => null)
    if (all) presets.value = all.filter(p => p.project === (props.project?.id ?? null))
}
watch(list, refresh, {immediate: true})

async function write(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, string>) {
    failed.value = ''
    try {
        await $fetch(url, {method, headers: {'Orrery-Actor': await load()}, body})
        await refresh()
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
const firstLine = (text: string) => text.split('\n').find(l => l.trim())?.trim() ?? ''
function change(preset: Preset, key: 'name' | 'text', event: Event) {
    const field = event.target as HTMLInputElement | HTMLTextAreaElement
    const value = field.value.trim()
    if (!value) field.value = preset[key]
    else if (value !== preset[key]) write(`/api/presets/${preset.id}`, 'PATCH', {[key]: value})
}
const remove = (preset: Preset) => write(`/api/presets/${preset.id}`, 'DELETE')

const line = 'h-8 min-w-0 flex-1 field'
const area = 'w-full field py-2 leading-5'
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul v-if="presets.length" class="flex flex-col divide-y divide-line/60">
      <li v-for="p in presets" :key="p.id" class="flex flex-col gap-1.5 py-2 first:pt-0">
        <div class="flex items-center gap-2">
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[13px] font-medium text-fg">{{ p.name }}</span>
            <span class="truncate text-xs text-muted">{{ firstLine(p.text) }}</span>
          </div>
          <UiButton size="xs" class="shrink-0" :aria-expanded="editing === p.id" :aria-label="`${editing === p.id ? 'Done editing' : 'Edit'} ${p.name}`" @click="editing = editing === p.id ? null : p.id">
            {{ editing === p.id ? 'Done' : 'Edit' }}
          </UiButton>
          <UiButton variant="danger-ghost" size="xs" square class="shrink-0" :aria-label="`Remove ${p.name}`" @click="remove(p)">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </UiButton>
        </div>
        <template v-if="editing === p.id">
          <input :value="p.name" :class="line" aria-label="Preset name" @blur="change(p, 'name', $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
          <textarea :value="p.text" rows="3" :class="area" :aria-label="`What ${p.name} tells a session`" @blur="change(p, 'text', $event)" />
        </template>
      </li>
    </ul>
    <form v-if="opened || !presets.length" class="flex flex-col gap-1.5" :class="{'border-t border-line/60 pt-3': presets.length}" @submit.prevent="add">
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
    <UiButton v-else size="sm" class="self-start" @click="opened = true">New preset</UiButton>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
