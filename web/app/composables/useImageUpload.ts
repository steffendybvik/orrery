import type {Ref} from 'vue'
import type {Upload} from '#shared/roadmap'

// Images in a Markdown field (a comment, an issue's description): pasted, dropped or picked, each is kept
// by Orrery and goes into `text` as Markdown where the cursor is in `field`, on a line of its own.
// `uploading` counts those on their way; `failed` says why the last didn't make it. `reset` drops those still on
// their way, for a field opened afresh (another issue, a dialog opened again, an edit cancelled), so a late one
// doesn't land in what's there now; leaving the component does the same.
export function useImageUpload(text: Ref<string>, field: Ref<HTMLTextAreaElement | null | undefined>) {
    const {load} = useOwner()
    const uploading = ref(0)
    const failed = ref('')
    const dragging = ref(false)
    /** Which opening of the field the uploads are for: one from an earlier one is dropped. */
    let round = 0

    function reset() {
        round++
        uploading.value = 0
        failed.value = ''
    }
    onScopeDispose(reset)

    function insert(markdown: string) {
        const element = field.value
        const at = element && document.activeElement === element ? element.selectionStart : text.value.length
        const before = text.value.slice(0, at)
        const after = text.value.slice(at)
        const lead = before && !before.endsWith('\n') ? '\n' : ''
        const trail = after.startsWith('\n') ? '' : '\n'
        text.value = before + lead + markdown + trail + after
        const cursor = (before + lead + markdown + trail).length
        nextTick(() => element?.setSelectionRange(cursor, cursor))
    }

    async function upload(files: File[]) {
        files = files.filter(file => file.type.startsWith('image/'))
        if (!files.length) return
        failed.value = ''
        uploading.value += files.length
        const mine = round
        for (const file of files) {
            if (mine !== round) return
            try {
                const image = await $fetch<Upload>('/api/uploads', {
                    method: 'POST', headers: {'Orrery-Actor': await load()}, body: {data: await readAsDataUrl(file), name: file.name || null},
                })
                if (mine === round) insert(image.markdown)
            } catch (error) {
                if (mine === round) failed.value = errorMessage(error, 'add')
            } finally {
                if (mine === round) uploading.value--
            }
        }
    }

    function onPaste(event: ClipboardEvent) {
        const files = [...event.clipboardData?.files ?? []].filter(file => file.type.startsWith('image/'))
        if (!files.length) return
        event.preventDefault()
        upload(files)
    }

    function onDrop(event: DragEvent) {
        dragging.value = false
        upload([...event.dataTransfer?.files ?? []])
    }

    return {uploading, failed, dragging, upload, reset, onPaste, onDrop}
}

/** The file as a `data:` URL, as `POST /api/uploads` takes it. */
export function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
    })
}
