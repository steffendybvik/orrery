<script setup lang="ts">
import type {ComponentPublicInstance, VNode} from 'vue'
import {Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions} from '@headlessui/vue'

// A property as a button with a menu to type in: the options narrow as you type, ↑↓ choose, ↵ picks,
// Esc closes. One value (a status, a chunk) closes on a pick; `multiple` (labels) toggles and stays open.
// `disabled` shuts an open menu (Headless UI does), so a `multiple` one stays enabled while a pick saves (ORR-602).
// `creatable` offers what was typed when nothing has that name (a new label, someone not assigned yet).
// `field` draws the button as a text field, sized to what it shows, for a row of them in a form (New issue);
// with `small` too, a toolbar's size (h-7, as the buttons beside it).
// Headless UI's Combobox does the keys, focus and outside-click; this only draws it. The menu opens from the
// button's left edge, or from its right when the window has no room for it that way.
interface PickerOption { value: string, label: string }

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
    /** A boxed button, as a field in a form, rather than a property's row. */
    field?: boolean
    /** With `field`, a toolbar's size rather than a form's. */
    small?: boolean
}>()
const model = defineModel<string | string[]>({required: true})

const query = ref('')
const trigger = ref<ComponentPublicInstance | null>(null)
const input = ref<ComponentPublicInstance | null>(null)

const typed = computed(() => query.value.trim())
const shown = computed(() => {
    const q = typed.value.toLowerCase()
    if (!q) return props.options
    const found = props.options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
    // Those starting with it first.
    return found.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)))
})
const isNew = computed(() => !!props.creatable && !!typed.value
    && !props.options.some(o => o.value.toLowerCase() === typed.value.toLowerCase() || o.label.toLowerCase() === typed.value.toLowerCase()))

function pick(value: string | string[]) {
    if (Array.isArray(value)) {
        model.value = value
        query.value = ''
    } else if (value !== model.value) model.value = value
}

// Headless UI keeps the picked option lit while it still matches; as the typing changes, the first that's left is
// lit instead (its own Home key), so ↵ picks what was typed for.
watch(query, () => nextTick(() => (input.value?.$el as HTMLElement | undefined)?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Home'}))))

/** How wide the menu is at least (`w-60`), and the room it keeps from the window's edge. */
const MENU = 240
const EDGE = 8
const fromRight = ref(false)

// Measured as it opens, from the button: the menu goes to the side it fits on.
function placing() {
    const box = (trigger.value?.$el as HTMLElement | undefined)?.getBoundingClientRect()
    fromRight.value = !!box && box.left + Math.max(MENU, box.width) > window.innerWidth - EDGE && box.right - MENU >= EDGE
}

// Closed from inside (a pick, Esc), the focus goes back to the button, as the field it was in goes;
// closed by pressing elsewhere, it stays where it went. What was typed goes too, before it opens again on what's picked.
function closing(vnode: VNode) {
    query.value = ''
    if ((vnode.el as HTMLElement | null)?.contains(document.activeElement)) nextTick(() => (trigger.value?.$el as HTMLElement | undefined)?.focus())
}
</script>

<template>
  <Combobox
      v-slot="{open}"
      as="div"
      class="relative min-w-0"
      :class="!field && 'flex-1'"
      :model-value="model"
      :multiple="multiple"
      :disabled="disabled"
      @update:model-value="pick"
  >
    <ComboboxButton
        ref="trigger"
        type="button"
        tabindex="0"
        :class="field && small
          ? 'flex h-7 max-w-44 min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-well pr-1.5 pl-2 text-left text-xs text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none disabled:cursor-default disabled:opacity-60'
          : field
          ? 'flex h-8 max-w-56 min-w-0 items-center gap-2 field pr-2 text-left disabled:cursor-default disabled:opacity-60'
          : '-ml-1.5 flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[13px] text-fg hover:bg-hover focus:bg-hover focus:outline-none disabled:cursor-default disabled:hover:bg-transparent'"
        :aria-label="label"
    >
      <slot />
      <svg v-if="field" class="ml-auto size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
    </ComboboxButton>
    <div
        v-if="open"
        class="glass absolute z-40 animate-fade-up rounded-xl p-1"
        :class="[up ? 'bottom-full mb-1' : 'top-full mt-1', fromRight ? 'right-0' : 'left-0', wide ? 'w-full min-w-60' : 'w-60']"
        @vue:before-mount="placing"
        @vue:before-unmount="closing"
    >
      <ComboboxInput
          ref="input"
          :display-value="() => query"
          :placeholder="placeholder ?? `Find ${label.toLowerCase()}…`"
          :aria-label="placeholder ?? label"
          spellcheck="false"
          autocomplete="off"
          class="mb-1 h-7 w-full rounded-lg bg-transparent px-2 text-[13px] text-fg placeholder:text-faint focus:outline-none"
          @change="query = ($event.target as HTMLInputElement).value"
      />
      <ComboboxOptions class="max-h-64 overflow-y-auto border-t border-line pt-1">
        <ComboboxOption v-for="option in shown" :key="option.value" v-slot="{active, selected}" :value="option.value" as="template">
          <li class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-fg" :class="active && 'bg-active'">
            <span v-if="multiple" class="grid size-3.5 shrink-0 place-items-center rounded ring-1" :class="selected ? 'bg-accent-500 ring-accent-500' : 'ring-faint/60'">
              <svg v-if="selected" class="size-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            </span>
            <slot name="option" :option="option"><span class="min-w-0 flex-1 truncate">{{ option.label }}</span></slot>
            <svg v-if="!multiple && selected" class="ml-auto size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </li>
        </ComboboxOption>
        <ComboboxOption v-if="isNew" v-slot="{active}" :value="typed" as="template">
          <li class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted" :class="active && 'bg-active'">
            <span class="grid size-3.5 shrink-0 place-items-center text-faint">+</span>
            {{ createVerb ?? 'Add' }} “<span class="truncate text-fg">{{ typed }}</span>”
          </li>
        </ComboboxOption>
        <li v-if="!shown.length && !isNew" class="px-2 py-1.5 text-xs text-faint">Nothing matches</li>
      </ComboboxOptions>
    </div>
  </Combobox>
</template>
