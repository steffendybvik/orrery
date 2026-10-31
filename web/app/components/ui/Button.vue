<script setup lang="ts">
// The app's button (docs/components.md). `variant`: primary (the one thing to do here), secondary (outlined,
// the default), ghost (no outline, for toolbars and rows), danger (removes something, once confirmed),
// danger-outline (asks to remove), danger-ghost (a quiet remove, red on hover), success (approves), success-outline and
// warning-outline (a step that moves something on, coloured like the state it leads to).
// `size`: xs (h-6, inline and in rows), sm (h-7, most places), md (h-8, dialogs and forms). `square` makes it
// an icon's size. With `to` it's a link that looks the same. Classes given where it's used should only place
// it (ml-auto, flex-1, w-full, max-md:hidden), not restyle it.
const props = withDefaults(defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'danger-ghost' | 'success' | 'success-outline' | 'warning-outline'
    size?: 'xs' | 'sm' | 'md'
    square?: boolean
    type?: 'button' | 'submit'
    to?: string
}>(), {variant: 'secondary', size: 'sm', type: 'button'})

const VARIANT = {
    'primary': 'bg-accent-fill font-medium text-on-accent hover:bg-accent-700',
    'secondary': 'text-muted ring-1 ring-line hover:bg-hover hover:text-fg',
    'ghost': 'text-muted hover:bg-hover hover:text-fg',
    'danger': 'bg-rose-600 font-medium text-white hover:opacity-90',
    'danger-outline': 'font-medium text-rose-700 ring-1 ring-rose-500/40 hover:bg-rose-500/10 dark:text-rose-400',
    'danger-ghost': 'text-muted hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-400',
    'success': 'bg-emerald-600 font-medium text-white hover:opacity-90',
    'success-outline': 'font-medium text-emerald-700 ring-1 ring-emerald-500/40 hover:bg-emerald-500/10 dark:text-emerald-300',
    'warning-outline': 'font-medium text-amber-800 ring-1 ring-amber-500/40 hover:bg-amber-500/10 dark:text-amber-300',
}
const SIZE = {
    xs: 'h-6 rounded-md px-1.5 text-xs',
    sm: 'h-7 rounded-md px-2.5 text-xs',
    md: 'h-8 rounded-lg px-3.5 text-[13px]',
}
const SQUARE = {xs: 'size-6 rounded-md', sm: 'size-7 rounded-md', md: 'size-8 rounded-lg'}

const classes = computed(() => [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap disabled:cursor-default disabled:opacity-50',
    VARIANT[props.variant],
    props.square ? SQUARE[props.size] : SIZE[props.size],
])
</script>

<template>
  <NuxtLink v-if="to" :to="to" :class="classes"><slot /></NuxtLink>
  <button v-else :type="type" :class="classes"><slot /></button>
</template>
