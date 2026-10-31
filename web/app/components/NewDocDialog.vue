<script setup lang="ts">
import type {Doc} from '#shared/roadmap'

// Writing a doc in a project, as the owner (so agents can't delete it): its title and its text, in Markdown.
// orrery makes its id from the title. An image pasted or dropped anywhere on the dialog, or picked, goes into the text
// as Markdown. An artifact (ORR-677) is the same with HTML for its text, and no images. ⌘↵ creates it and opens it, Esc closes.
const {target, kind, close} = useNewDoc()
const artifact = computed(() => kind.value === 'artifact')
const {byId} = useRoadmaps()
const router = useRouter()

const project = computed(() => byId(target.value ?? undefined))
const title = ref('')
const body = ref('')
const saving = ref(false)
const failed = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
const bodyInput = ref<HTMLTextAreaElement | null>(null)
// An image pasted, dropped or picked goes in as Markdown where the cursor is.
const {uploading, failed: uploadError, upload, reset: resetUploads, over, on: drop} = useImageUpload(body, bodyInput)

watch(target, now => {
    if (!now) return
    title.value = body.value = failed.value = ''
    resetUploads()
}, {immediate: true})
// Its field takes the cursor once it's there: on the first open the dialog is still loading when the watch above runs.
watch(titleInput, el => el?.focus())

const ready = computed(() => !!title.value.trim() && !saving.value && !uploading.value)

async function create() {
    if (!ready.value || !target.value) return
    saving.value = true
    failed.value = ''
    const at = target.value
    try {
        const doc = await apiFetch<Doc>(`/projects/${encodeURIComponent(at)}/docs`, {
            method: 'POST',
            body: {title: title.value.trim(), body: body.value.trim(), ...artifact.value ? {kind: 'artifact'} : {}},
        })
        close()
        router.push(`/p/${at}/docs/${doc.id}`)
    } catch (error) {
        failed.value = errorMessage(error, 'create')
    } finally {
        saving.value = false
    }
}
</script>

<template>
  <UiDialog :open="target" :label="artifact ? 'New artifact' : 'New doc'" width="2xl" class="relative" v-on="artifact ? {} : drop" @close="close" @submit="create">
    <ImageDropOverlay v-if="over" />
    <div class="flex items-center gap-2 text-xs text-faint">
      <span>{{ artifact ? 'New artifact' : 'New doc' }}<template v-if="project"> in {{ project.name }}</template></span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>
    <input ref="titleInput" v-model="title" :placeholder="artifact ? 'Artifact title, e.g. Test speed' : 'Doc title, e.g. How releases work'" aria-label="Title" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
    <textarea
        ref="bodyInput"
        v-model="body"
        rows="8"
        :placeholder="artifact ? 'Write it in HTML, with Tailwind classes. It runs in a locked-down frame: everything has to be inline.' : 'Write it in Markdown (paste or drop an image)'"
        aria-label="Text"
        class="field-sizing-content max-h-[60vh] min-h-40 resize-none bg-transparent font-mono text-[13px] leading-6 text-fg placeholder:text-faint focus:outline-none"
    />
    <div class="flex items-center gap-2 border-t border-line pt-3">
      <ImageButton v-if="!artifact" @picked="upload" />
      <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
      <span v-else-if="uploading" class="text-xs text-faint">Adding image…</span>
      <span v-else-if="uploadError" class="text-xs text-rose-700 dark:text-rose-400">{{ uploadError }}</span>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="!ready">
        {{ saving ? 'Creating…' : artifact ? 'Create artifact' : 'Create doc' }} <KeyHint class="bg-black/10 text-zinc-950 ring-0">⌘↵</KeyHint>
      </UiButton>
    </div>
  </UiDialog>
</template>
