<script setup lang="ts">
// A dialog over a dimmed page (docs/components.md): a form on the glass panel, near the top, scrolling with the
// page when it's taller than the window. Esc, or a press on the dimmed page, emits `close` (not when `required`);
// Enter in a field and ⌘↵ emit `submit`. `width` is the panel's widest; `flush` drops its padding, for one that
// lays out its own (⌘K). Classes given where it's used go on the panel.
defineOptions({inheritAttrs: false})
withDefaults(defineProps<{
    open: unknown
    label: string
    width?: 'md' | 'lg' | 'xl' | '2xl'
    flush?: boolean
    required?: boolean
}>(), {width: 'lg'})
const emit = defineEmits<{close: [], submit: []}>()

const WIDTH = {md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl', '2xl': 'max-w-2xl'}
</script>

<template>
  <Teleport to="body">
    <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-[12vh] backdrop-blur-[2px]"
        @pointerdown.self="required || emit('close')"
    >
      <form
          v-bind="$attrs"
          :class="['glass flex w-full animate-fade-up flex-col rounded-2xl', WIDTH[width], flush ? '' : 'gap-3 p-5']"
          role="dialog"
          :aria-label="label"
          @submit.prevent="emit('submit')"
          @keydown.esc.stop="required || emit('close')"
          @keydown.meta.enter.prevent="emit('submit')"
          @keydown.ctrl.enter.prevent="emit('submit')"
      >
        <slot />
      </form>
    </div>
  </Teleport>
</template>
