<script setup lang="ts">
import type {Preset, Project} from '#shared/roadmap'

// Writing a preset, new or one already made: its text, what a session is told, is the dialog, in a field that reads
// as one (it opens full), and takes the cursor; its name and badge sit above it, the badge's picker behind its
// button. ⌘↵ saves, Esc closes. One orrery ships, once changed, can be reset to what it ships.
const props = defineProps<{open: Preset | 'new' | null, project?: Project}>()
const emit = defineEmits<{close: [], saved: []}>()
const {load} = useOwner()

const editing = computed(() => props.open && props.open !== 'new' ? props.open : null)
const draft = reactive({name: '', text: '', icon: null as string | null, color: null as string | null})
const badging = ref(false)
const saving = ref(false)
const failed = ref('')
const textInput = ref<HTMLTextAreaElement | null>(null)

watch(() => props.open, now => {
    if (!now) return
    Object.assign(draft, now === 'new' ? {name: '', text: '', icon: null, color: null} : {name: now.name, text: now.text, icon: now.icon, color: now.color})
    badging.value = false
    failed.value = ''
}, {immediate: true})
// The text takes the cursor once it's there: on the first open the dialog is still loading when the watch above runs.
watch(textInput, el => el?.focus())

const ready = computed(() => !!draft.name.trim() && !!draft.text.trim() && !saving.value)
const list = computed(() => props.project ? `/api/projects/${encodeURIComponent(props.project.id)}/presets` : '/api/presets')

async function send(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: object) {
    saving.value = true
    failed.value = ''
    try {
        await $fetch(url, {method, headers: {'Orrery-Actor': await load()}, body})
        emit('saved')
        emit('close')
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}
function save() {
    if (!ready.value) return
    const body = {name: draft.name.trim(), text: draft.text.trim(), icon: draft.icon, color: draft.color}
    send(editing.value ? `/api/presets/${editing.value.id}` : list.value, editing.value ? 'PATCH' : 'POST', body)
}
const remove = () => editing.value && send(`/api/presets/${editing.value.id}`, 'DELETE')
const reset = () => editing.value && send(`/api/presets/${editing.value.id}/reset`, 'POST')
</script>

<template>
  <UiDialog :open="open" :label="editing ? `Edit ${editing.name}` : 'New preset'" width="2xl" @close="emit('close')" @submit="save">
    <div class="flex items-center gap-2 text-xs text-faint">
      <span>{{ editing ? 'Preset' : 'New preset' }} · for {{ project ? `sessions on ${project.name}` : 'sessions on any project' }}</span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>
    <div class="flex items-center gap-3">
      <button
          type="button"
          class="rounded-[28%] transition-opacity hover:opacity-80"
          :aria-expanded="badging"
          aria-label="Badge"
          title="Badge: an icon and colour, or its initials"
          @click="badging = !badging"
      >
        <PresetBadge :preset="{name: draft.name || '?', icon: draft.icon, color: draft.color}" :size="32" />
      </button>
      <input v-model="draft.name" placeholder="Name, e.g. Review" aria-label="Preset name" class="min-w-0 flex-1 bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
    </div>
    <IconPicker v-if="badging" :icon="draft.icon" :color="draft.color" label="Badge" @change="Object.assign(draft, $event)">
      <UiButton v-if="draft.icon" size="xs" class="self-start" @click="draft.icon = null">Use its initials</UiButton>
    </IconPicker>
    <label for="preset-text" class="-mb-2 text-xs font-medium text-muted">What it tells a session</label>
    <textarea
        id="preset-text"
        ref="textInput"
        v-model="draft.text"
        rows="12"
        :placeholder="project ? `What it tells a session on ${project.name}, e.g. run the e2e suite before you finish` : 'What it tells a session, e.g. you\'re reviewing: read the diff and comment, don\'t change code'"
        class="field-sizing-content max-h-[60vh] min-h-64 resize-none rounded-lg bg-well px-3 py-2 font-mono text-[13px] leading-6 text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
    />
    <div class="flex items-center gap-2 border-t border-line pt-3">
      <UiButton v-if="editing" variant="danger-ghost" size="sm" @click="remove">Remove {{ editing.name }}</UiButton>
      <UiButton v-if="editing?.default?.changed" size="sm" title="Put back the name, text and badge orrery ships it with" @click="reset">Reset to default</UiButton>
      <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="!ready">
        {{ saving ? 'Saving…' : editing ? 'Save preset' : 'Add preset' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
      </UiButton>
    </div>
  </UiDialog>
</template>
