<script setup lang="ts">
// "Copy", then "Copied" with a tick for a moment ("Couldn't copy" where the browser won't). `name` says what it copies, where the text is too long to.
// `compact` shows the icon alone on a phone (the label stays for screen readers).
const props = withDefaults(defineProps<{text: string, label?: string, name?: string, compact?: boolean}>(), {label: 'Copy'})
const copied = ref<'yes' | 'no' | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
    copied.value = await copyText(props.text) ? 'yes' : 'no'
    clearTimeout(timer)
    timer = setTimeout(() => copied.value = null, copied.value === 'yes' ? 1200 : 2400)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] whitespace-nowrap ring-1 transition-colors"
      :class="copied === 'yes' ? 'text-emerald-600 ring-emerald-500/40 dark:text-emerald-400'
        : copied === 'no' ? 'text-rose-600 ring-rose-500/40 dark:text-rose-400' : 'text-faint ring-line hover:bg-hover hover:text-fg'"
      :title="`Copy ${name ?? text}`"
      :aria-label="`Copy ${name ?? text}`"
      @click="copy"
  >
    <svg v-if="copied === 'yes'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
    <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
    <span :class="compact && 'max-sm:sr-only'" aria-live="polite">{{ copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : label }}</span>
  </button>
</template>
