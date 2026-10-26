<script setup lang="ts">
// A property as a button with a menu to type in: the options narrow as you type, ↑↓ choose, ↵ picks,
// Esc closes. One value (a status, a chunk) closes on a pick; `multiple` (labels) toggles and stays open.
// `creatable` offers what was typed when nothing has that name (a new label, someone not assigned yet).
export interface PickerOption { value: string, label: string }

const props = defineProps<{
    options: PickerOption[]
    label: string
    placeholder?: string
    multiple?: boolean
    creatable?: boolean
    /** What the row to make a new one says, before the typed name: `Add`, `Assign`. */
    createVerb?: string
    disabled?: boolean
    /** Opens above the button, as in a bar at the bottom of the page. */
    up?: boolean
    /** Its menu as wide as the button (at least the usual), for long options such as issue titles. */
    wide?: boolean
}>()
const model = defineModel<string | string[]>({required: true})

const open = ref(false)
const query = ref('')
const active = ref(0)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const typed = computed(() => query.value.trim())
const picked = (value: string) => Array.isArray(model.value) ? model.value.includes(value) : model.value === value
const shown = computed(() => {
    const q = typed.value.toLowerCase()
    if (!q) return props.options
    const found = props.options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
    // Those starting with it first.
    return found.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)))
})
const isNew = computed(() => !!props.creatable && !!typed.value
    && !props.options.some(o => o.value.toLowerCase() === typed.value.toLowerCase() || o.label.toLowerCase() === typed.value.toLowerCase()))
/** The rows ↑↓ move through: the options shown, then the new one. */
const count = computed(() => shown.value.length + Number(isNew.value))

function pick(value: string) {
    if (Array.isArray(model.value)) {
        model.value = model.value.includes(value) ? model.value.filter(v => v !== value) : [...model.value, value]
        query.value = ''
        nextTick(() => input.value?.focus())
        return
    }
    if (value !== model.value) model.value = value
    close()
}

function choose() {
    if (active.value < shown.value.length) pick(shown.value[active.value]!.value)
    else if (isNew.value) pick(typed.value)
}

function close(refocus = true) {
    if (!open.value) return
    open.value = false
    if (refocus) nextTick(() => trigger.value?.focus())
}

function onKey(event: KeyboardEvent) {
    const n = count.value
    if (event.key === 'Escape') close()
    else if (event.key === 'Enter') choose()
    else if (n && event.key === 'ArrowDown') active.value = (active.value + 1) % n
    else if (n && event.key === 'ArrowUp') active.value = (active.value + n - 1) % n
    else if (event.key === 'Tab') return close(false)
    else return
    event.preventDefault()
    event.stopPropagation()
}

function onOutside(event: PointerEvent) {
    if (!root.value?.contains(event.target as Node)) close(false)
}

watch(query, () => active.value = 0)
watch(open, isOpen => {
    query.value = ''
    // Opens on what's picked, so ↵ straight away keeps it.
    active.value = Math.max(0, props.options.findIndex(o => picked(o.value)))
    if (isOpen) nextTick(() => input.value?.focus())
    isOpen ? document.addEventListener('pointerdown', onOutside) : document.removeEventListener('pointerdown', onOutside)
})
watch(active, index => nextTick(() => list.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({block: 'nearest'})))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside))
</script>

<template>
  <div ref="root" class="relative min-w-0 flex-1">
    <button
        ref="trigger"
        type="button"
        class="-ml-1.5 flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[13px] text-fg hover:bg-hover focus:bg-hover focus:outline-none disabled:cursor-default disabled:hover:bg-transparent"
        :disabled="disabled"
        :aria-label="label"
        aria-haspopup="listbox"
        :aria-expanded="open"
        @click="open = !open"
        @keydown.down.prevent="open = true"
    >
      <slot />
    </button>
    <div v-if="open" class="glass absolute left-0 z-40 animate-fade-up rounded-xl p-1" :class="[up ? 'bottom-full mb-1' : 'top-full mt-1', wide ? 'right-0 min-w-60' : 'w-60']" @keydown="onKey">
      <input
          ref="input"
          v-model="query"
          :placeholder="placeholder ?? `Find ${label.toLowerCase()}…`"
          :aria-label="placeholder ?? label"
          spellcheck="false"
          class="mb-1 h-7 w-full rounded-lg bg-transparent px-2 text-[13px] text-fg placeholder:text-faint focus:outline-none"
      >
      <ul ref="list" class="max-h-64 overflow-y-auto border-t border-line pt-1" role="listbox" :aria-multiselectable="multiple">
        <li
            v-for="(option, index) in shown"
            :key="option.value"
            :data-index="index"
            role="option"
            :aria-selected="picked(option.value)"
            class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-fg"
            :class="index === active ? 'bg-active' : 'hover:bg-hover'"
            @mouseenter="active = index"
            @click="pick(option.value)"
        >
          <span v-if="multiple" class="grid size-3.5 shrink-0 place-items-center rounded ring-1" :class="picked(option.value) ? 'bg-accent-500 ring-accent-500' : 'ring-faint/60'">
            <svg v-if="picked(option.value)" class="size-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </span>
          <slot name="option" :option="option"><span class="min-w-0 flex-1 truncate">{{ option.label }}</span></slot>
          <svg v-if="!multiple && picked(option.value)" class="ml-auto size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
        </li>
        <li
            v-if="isNew"
            :data-index="shown.length"
            role="option"
            :aria-selected="false"
            class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted"
            :class="active === shown.length ? 'bg-active' : 'hover:bg-hover'"
            @mouseenter="active = shown.length"
            @click="pick(typed)"
        >
          <span class="grid size-3.5 shrink-0 place-items-center text-faint">+</span>
          {{ createVerb ?? 'Add' }} “<span class="truncate text-fg">{{ typed }}</span>”
        </li>
        <li v-if="!count" class="px-2 py-1.5 text-xs text-faint">Nothing matches</li>
      </ul>
    </div>
  </div>
</template>
