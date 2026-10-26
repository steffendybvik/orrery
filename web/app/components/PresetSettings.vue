<script setup lang="ts">
import type {Preset, Project} from '#shared/roadmap'

// Presets: saved pieces of context to give a session as you start it, each a name and its text. On App settings
// they're the Orrery's, for sessions on any project; with `project`, that project's own. Edited in place (saved
// on leaving the field), added and removed.
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

const adding = reactive({name: '', text: ''})
async function add() {
    if (!adding.name.trim() || !adding.text.trim()) return
    if (await write(list.value, 'POST', {...adding})) adding.name = adding.text = ''
}
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
    <ul v-if="presets.length" class="flex flex-col gap-3">
      <li v-for="p in presets" :key="p.id" class="flex flex-col gap-1.5">
        <div class="flex items-center gap-2">
          <input :value="p.name" :class="line" aria-label="Preset name" @blur="change(p, 'name', $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
          <UiButton variant="danger-ghost" square class="shrink-0" :aria-label="`Remove ${p.name}`" @click="remove(p)">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </UiButton>
        </div>
        <textarea :value="p.text" rows="3" :class="area" :aria-label="`What ${p.name} tells a session`" @blur="change(p, 'text', $event)" />
      </li>
    </ul>
    <form class="flex flex-col gap-1.5" :class="{'border-t border-line/60 pt-3': presets.length}" @submit.prevent="add">
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
      <UiButton type="submit" size="md" class="self-end" :disabled="!adding.name.trim() || !adding.text.trim()">Add preset</UiButton>
    </form>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
