<script setup lang="ts">
import {BoldIcon, CodeBracketIcon, H2Icon, ItalicIcon, LinkIcon, ListBulletIcon, NumberedListIcon, StrikethroughIcon} from '@heroicons/vue/20/solid'
import type {Component} from 'vue'
import {applyEdit, wrapInCode} from '~/utils/codeBlocks'
import type {CodeEdit} from '~/utils/codeBlocks'
import {continueList, highlightMarkdown, insertLink, toggleLines, toggleMark} from '~/utils/markdownEdit'
import type {Mark, Prefix} from '~/utils/markdownEdit'

// A text box for Markdown (ORR-932): the chat, comments and an issue's notes. It's a real textarea, so the value stays
// plain Markdown and pasting, ⌘Z and the browser's spelling work as they do anywhere, with the source drawn behind it
// with its formatting showing as you type (markers faint, bold, italic, highlight, code, headings, lists, links).
// Keys: ⌘B bold, ⌘I italic, ⌘⇧H highlight, ⌘⇧X strike, ⌘⇧8 bullets, ⌘⇧7 numbers, ⌘⇧. quote, and ⌘E code (every
// text box has that one, plugins/code-blocks). Enter on a list line starts the next item, or ends the list on an empty
// one; with `enterSends` (the chat, where Enter sends) that's Shift-Enter.
// `toolbar` shows the buttons above the box. Everything else given to it (class, rows, placeholder, aria-label,
// listeners) goes on the textarea; `el` is the textarea, for focusing and images (useImageUpload).
defineOptions({inheritAttrs: false})
const props = defineProps<{toolbar?: boolean, enterSends?: boolean}>()
const value = defineModel<string>({required: true})
const el = ref<HTMLTextAreaElement>()
const draw = ref<HTMLDivElement>()
defineExpose({el})

const html = computed(() => highlightMarkdown(value.value))

// The drawing takes the box's place and type exactly, so each character sits under its own.
const COPIED = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const
function fit() {
    const box = el.value
    const behind = draw.value
    if (!box || !behind) return
    const style = getComputedStyle(box)
    for (const key of COPIED) behind.style[key] = style[key]
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
    // To the fraction of a pixel, as offsetWidth and the like round.
    const rect = box.getBoundingClientRect()
    const around = behind.parentElement?.getBoundingClientRect() ?? rect
    behind.style.top = `${rect.top - around.top}px`
    behind.style.left = `${rect.left - around.left}px`
    // Less a scrollbar, where the box has one.
    behind.style.width = `${rect.width - (box.offsetWidth - box.clientWidth - borders)}px`
    behind.style.height = `${rect.height}px`
    behind.scrollTop = box.scrollTop
}
let observer: ResizeObserver | undefined
onMounted(() => {
    fit()
    observer = new ResizeObserver(fit)
    if (el.value) observer.observe(el.value)
    // The font coming in late moves nothing in the box, but its sizes change.
    void document.fonts?.ready.then(fit)
})
onBeforeUnmount(() => observer?.disconnect())
watch(html, () => nextTick(fit))

function edit(make: (text: string, start: number, end: number) => CodeEdit | null) {
    const box = el.value
    if (!box || box.readOnly || box.disabled) return false
    const change = make(box.value, box.selectionStart, box.selectionEnd)
    if (!change) return false
    box.focus()
    applyEdit(box, change)
    return true
}
const mark = (m: Mark) => edit((t, s, e) => toggleMark(t, s, e, m))
const lines = (p: Prefix) => edit((t, s, e) => toggleLines(t, s, e, p))

const BUTTONS: {label: string, icon: Component | null, glyph?: 'highlight' | 'quote', run: () => unknown}[] = [
    {label: 'Heading', icon: H2Icon, run: () => lines('heading')},
    {label: 'Bold (⌘B)', icon: BoldIcon, run: () => mark('bold')},
    {label: 'Italic (⌘I)', icon: ItalicIcon, run: () => mark('italic')},
    {label: 'Strikethrough (⌘⇧X)', icon: StrikethroughIcon, run: () => mark('strike')},
    {label: 'Highlight (⌘⇧H)', icon: null, glyph: 'highlight', run: () => mark('highlight')},
    {label: 'Code (⌘E)', icon: CodeBracketIcon, run: () => edit(wrapInCode)},
    {label: 'Link', icon: LinkIcon, run: () => edit(insertLink)},
    {label: 'Bulleted list (⌘⇧8)', icon: ListBulletIcon, run: () => lines('bullets')},
    {label: 'Numbered list (⌘⇧7)', icon: NumberedListIcon, run: () => lines('numbers')},
    {label: 'Quote (⌘⇧.)', icon: null, glyph: 'quote', run: () => lines('quote')},
]

/** The key a shortcut is told by: `event.code` for the shifted digits and the full stop, as Shift changes `key`. */
function shortcut(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    if (!event.shiftKey) return key === 'b' ? () => mark('bold') : key === 'i' ? () => mark('italic') : null
    switch (event.code) {
        case 'KeyH': return () => mark('highlight')
        case 'KeyX': return () => mark('strike')
        case 'Digit8': return () => lines('bullets')
        case 'Digit7': return () => lines('numbers')
        case 'Period': return () => lines('quote')
    }
    return null
}

function onKey(event: KeyboardEvent) {
    if (event.isComposing || event.altKey) return
    let done = false
    if (event.metaKey || event.ctrlKey) {
        const run = shortcut(event)
        if (run) {
            run()
            done = true
        }
    } else if (event.key === 'Enter' && event.shiftKey === !!props.enterSends) {
        const box = el.value
        done = !!box && box.selectionStart === box.selectionEnd && edit(continueList)
    }
    if (!done) return
    event.preventDefault()
    // Before the box's own keys (given to it as listeners), so Enter doesn't also send.
    event.stopImmediatePropagation()
}
</script>

<template>
  <div class="flex min-w-0 flex-col">
    <div v-if="toolbar" role="toolbar" aria-label="Formatting" class="flex flex-wrap items-center gap-0.5 px-1 pb-1">
      <UiButton
          v-for="b in BUTTONS"
          :key="b.label"
          variant="ghost"
          size="xs"
          square
          :aria-label="b.label"
          :title="b.label"
          tabindex="-1"
          @mousedown.prevent
          @click="b.run"
      >
        <component :is="b.icon" v-if="b.icon" class="size-4" />
        <span v-else-if="b.glyph === 'highlight'" class="rounded-sm bg-amber-300/50 px-0.5 text-[11px] leading-4 font-semibold text-fg dark:bg-amber-400/30" aria-hidden="true">ab</span>
        <span v-else class="text-base leading-none font-semibold" aria-hidden="true">”</span>
      </UiButton>
    </div>
    <div class="relative flex min-w-0 flex-1 flex-col">
      <!-- eslint-disable-next-line vue/no-v-html -- highlightMarkdown escapes the source; it only adds spans -->
      <div ref="draw" class="md-draw" aria-hidden="true" v-html="html" />
      <textarea
          ref="el"
          v-model="value"
          class="md-input"
          @keydown="onKey"
          @scroll="fit"
          v-bind="$attrs"
      />
    </div>
  </div>
</template>
