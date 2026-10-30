import type {Ref} from 'vue'
import type {Upload} from '#shared/roadmap'

// Images in a Markdown field (a comment, an issue's description): pasted, dropped or picked, each is kept
// by orrery and goes into `text` as Markdown where the cursor is in `field`, on a line of its own, and the focus goes
// back to `field` after it. Pasting and dropping work on the whole area around the field (`over` and `on`, see
// useImageDrop).
// `uploading` counts those on their way; `failed` says why the last didn't make it. `reset` drops those still on
// their way, for a field opened afresh (another issue, a dialog opened again, an edit cancelled), so a late one
// doesn't land in what's there now; leaving the component does the same.
export function useImageUpload(text: Ref<string>, field: Ref<HTMLTextAreaElement | null | undefined>) {
    const uploading = ref(0)
    const failed = ref('')
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
        nextTick(() => {
            element?.focus()
            element?.setSelectionRange(cursor, cursor)
        })
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
                const image = await apiFetch<Upload>('/uploads', {
                    method: 'POST', body: {data: await readAsDataUrl(file), name: file.name || null},
                })
                if (mine === round) insert(image.markdown)
            } catch (error) {
                if (mine === round) failed.value = errorMessage(error, 'add')
            } finally {
                if (mine === round) uploading.value--
            }
        }
    }

    return {uploading, failed, upload, reset, ...useImageDrop(upload)}
}

/** A whole area taking images (ORR-437): `on` goes on it (`v-on`), and while an image is dragged over it, `over`, it
 * shows ImageDropOverlay. One dropped anywhere on it, or pasted while the focus is anywhere inside it, goes to
 * `upload`. Only a drag carrying files counts, not dragged text or a link. dragenter and dragleave fire on every element
 * inside it, so they're counted, or the overlay would flicker. */
export function useImageDrop(upload: (files: File[]) => unknown) {
    const over = ref(false)
    let depth = 0
    const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')
    const images = (files: FileList | undefined) => [...files ?? []].filter(file => file.type.startsWith('image/'))
    const on = {
        dragenter(event: DragEvent) {
            if (!carriesFiles(event)) return
            event.preventDefault()
            depth++
            over.value = true
        },
        dragover(event: DragEvent) {
            if (!carriesFiles(event)) return
            event.preventDefault()
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        },
        dragleave(event: DragEvent) {
            if (!carriesFiles(event)) return
            depth = Math.max(0, depth - 1)
            if (!depth) over.value = false
        },
        drop(event: DragEvent) {
            if (!carriesFiles(event)) return
            event.preventDefault()
            depth = 0
            over.value = false
            const files = images(event.dataTransfer?.files)
            if (files.length) upload(files)
        },
        paste(event: ClipboardEvent) {
            const files = images(event.clipboardData?.files)
            if (!files.length) return
            event.preventDefault()
            upload(files)
        },
    }
    return {over, on}
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
