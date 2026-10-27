<script setup lang="ts">
import type {Chunk} from '#shared/roadmap'

// Starting a chunk in a project, as the owner (so agents can't delete it): its title and what it's for,
// in Markdown. Orrery gives it the next number. ⌘↵ creates it and opens it, Esc closes.
const {target, close} = useNewChunk()
const {byId} = useRoadmaps()
const {load} = useOwner()
const router = useRouter()

const project = computed(() => byId(target.value ?? undefined))
const title = ref('')
const summary = ref('')
const saving = ref(false)
const failed = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

watch(target, now => {
    if (!now) return
    title.value = summary.value = failed.value = ''
}, {immediate: true})
// Its field takes the cursor once it's there: on the first open the dialog is still loading when the watch above runs.
watch(titleInput, el => el?.focus())

const ready = computed(() => !!title.value.trim() && !saving.value)

async function create() {
    if (!ready.value || !target.value) return
    saving.value = true
    failed.value = ''
    const at = target.value
    try {
        const chunk = await $fetch<Chunk>(`/api/projects/${encodeURIComponent(at)}/chunks`, {
            method: 'POST',
            headers: {'Orrery-Actor': await load()},
            body: {title: title.value.trim(), ...summary.value.trim() ? {summary: summary.value.trim()} : {}},
        })
        close()
        router.push(chunkPath(at, chunk.id))
    } catch (error) {
        failed.value = errorMessage(error, 'create')
    } finally {
        saving.value = false
    }
}
</script>

<template>
  <UiDialog :open="target" label="New chunk" @close="close" @submit="create">
    <div class="flex items-center gap-2 text-xs text-faint">
      <span>New chunk<template v-if="project"> in {{ project.name }}</template></span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>
    <input ref="titleInput" v-model="title" placeholder="Chunk title, e.g. Moving parts" aria-label="Title" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
    <textarea
        v-model="summary"
        rows="3"
        placeholder="What it's for, in Markdown (optional)"
        aria-label="Summary"
        class="field-sizing-content min-h-16 resize-none bg-transparent text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
    />
    <div class="flex items-center gap-2 border-t border-line pt-3">
      <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="!ready">
        {{ saving ? 'Creating…' : 'Create chunk' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
      </UiButton>
    </div>
  </UiDialog>
</template>
