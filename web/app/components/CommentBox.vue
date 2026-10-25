<script setup lang="ts">
import {PhotoIcon} from '@heroicons/vue/24/outline'
import type {Comment, Upload} from '#shared/roadmap'

// Writing a comment on an issue, as the owner (so it's theirs: agents can't edit or delete it).
// Markdown works; ⌘↵ posts. An image pasted, dropped or picked is kept by Orrery and goes in as Markdown
// where the cursor is.
const props = defineProps<{project: string, issue: string}>()
const emit = defineEmits<{posted: [comment: Comment]}>()
const {load} = useOwner()
const body = ref('')
const posting = ref(false)
const failed = ref(false)
const field = ref<HTMLTextAreaElement>()
const picker = ref<HTMLInputElement>()
const uploading = ref(0)
const uploadError = ref('')
const dragging = ref(false)

async function post() {
    const text = body.value.trim()
    if (!text || posting.value || uploading.value) return
    posting.value = true
    failed.value = false
    try {
        const comment = await $fetch<Comment>(`/api/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/comments`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {body: text},
        })
        body.value = ''
        emit('posted', comment)
        // Answering may settle a comment waiting on the owner.
        useInbox().refresh()
    } catch {
        failed.value = true
    } finally {
        posting.value = false
    }
}

function images(files: FileList | null | undefined): File[] {
    return [...files ?? []].filter(file => file.type.startsWith('image/'))
}

function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
    })
}

/** Puts `text` where the cursor is (or at the end), on a line of its own. */
function insert(text: string) {
    const element = field.value
    const at = element && document.activeElement === element ? element.selectionStart : body.value.length
    const before = body.value.slice(0, at)
    const after = body.value.slice(at)
    const lead = before && !before.endsWith('\n') ? '\n' : ''
    const trail = after.startsWith('\n') ? '' : '\n'
    body.value = before + lead + text + trail + after
    const cursor = (before + lead + text + trail).length
    nextTick(() => element?.setSelectionRange(cursor, cursor))
}

async function upload(files: File[]) {
    if (!files.length) return
    uploadError.value = ''
    uploading.value += files.length
    for (const file of files) {
        try {
            const image = await $fetch<Upload>('/api/uploads', {
                method: 'POST', headers: {'Orrery-Actor': await load()}, body: {data: await readAsDataUrl(file), name: file.name || null},
            })
            insert(image.markdown)
        } catch (error) {
            uploadError.value = errorMessage(error, 'add')
        } finally {
            uploading.value--
        }
    }
}

function onPaste(event: ClipboardEvent) {
    const files = images(event.clipboardData?.files)
    if (!files.length) return
    event.preventDefault()
    upload(files)
}

function onDrop(event: DragEvent) {
    dragging.value = false
    upload(images(event.dataTransfer?.files))
}

function onPick() {
    upload(images(picker.value?.files))
    if (picker.value) picker.value.value = ''
}
</script>

<template>
  <form
      class="flex flex-col gap-2 rounded-xl bg-well p-2 ring-1 ring-line focus-within:ring-accent-500/50"
      :class="dragging && 'ring-accent-500/50'"
      @submit.prevent="post"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
  >
    <textarea
        ref="field"
        v-model="body"
        rows="3"
        placeholder="Leave a comment… (Markdown works, paste or drop an image, ⌘↵ to post)"
        aria-label="Comment"
        class="min-h-20 resize-y bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
        @paste="onPaste"
        @keydown.meta.enter.prevent="post"
        @keydown.ctrl.enter.prevent="post"
    />
    <div class="flex items-center gap-2 px-1">
      <button
          type="button"
          class="flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
          title="Add an image"
          aria-label="Add an image"
          @click="picker?.click()"
      ><PhotoIcon class="size-4" /></button>
      <input ref="picker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="hidden" @change="onPick">
      <span v-if="uploading" class="text-xs text-faint">Adding image…</span>
      <span v-else-if="uploadError" class="text-xs text-rose-600 dark:text-rose-400">{{ uploadError }}</span>
      <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">Couldn't post. Is Orrery running?</span>
      <button
          type="submit"
          class="ml-auto h-7 rounded-md bg-accent-500 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          :disabled="!body.trim() || posting || !!uploading"
      >{{ posting ? 'Posting…' : 'Comment' }}</button>
    </div>
  </form>
</template>
