import {applyEdit, enterInCode, wrapInCode} from '~/utils/codeBlocks'

// Code blocks in every text box (ORR-647): ⌘E (Ctrl-E) wraps what's selected, or starts an empty block, and Enter after
// ``` closes the block below the cursor. Enter inside a block is a new line, even in a box where it sends. Listened to
// before the box's own keys, so those don't see what's handled here.
export default defineNuxtPlugin(() => {
    document.addEventListener('keydown', event => {
        const box = event.target
        if (!(box instanceof HTMLTextAreaElement) || box.readOnly || box.disabled || event.isComposing) return
        const command = event.metaKey || event.ctrlKey
        const {value, selectionStart: start, selectionEnd: end} = box
        const edit = command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e' ? wrapInCode(value, start, end)
            : !command && !event.altKey && event.key === 'Enter' && start === end ? enterInCode(value, start)
            : null
        if (!edit) return
        event.preventDefault()
        event.stopPropagation()
        applyEdit(box, edit)
    }, {capture: true})
})
