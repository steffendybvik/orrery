<script setup lang="ts">
// A menu at the pointer, for a right-click (docs/components.md): a `menu` panel kept inside the window, focused as it
// opens, and closed by Esc, a press outside it, or the window losing focus or changing size. `at` opens it where the
// right-click was (nothing closes it); `label` names it; `width` is its width class. Headless UI has no right-click
// menu, so this is the one place that draws one.
const props = withDefaults(defineProps<{
    at: {x: number, y: number} | null | undefined
    label: string
    width?: string
}>(), {width: 'w-64'})
const emit = defineEmits<{close: []}>()

const box = ref<HTMLElement | null>(null)
const place = ref({left: 0, top: 0})

watch(() => props.at, now => {
    if (!now) return
    place.value = {left: now.x, top: now.y}
    // Kept inside the window once it's drawn and its size is known.
    nextTick(() => {
        const rect = box.value?.getBoundingClientRect()
        if (!rect) return
        place.value = {
            left: Math.max(8, Math.min(now.x, window.innerWidth - rect.width - 8)),
            top: Math.max(8, Math.min(now.y, window.innerHeight - rect.height - 8)),
        }
        box.value?.focus()
    })
}, {immediate: true})

useDismiss(box, () => props.at, () => emit('close'), {capture: true, blur: true, resize: true})
</script>

<template>
  <Teleport to="body">
    <div
        v-if="at"
        ref="box"
        class="menu fixed z-50"
        :class="width"
        :style="{left: `${place.left}px`, top: `${place.top}px`}"
        role="menu"
        :aria-label="label"
        tabindex="-1"
        @keydown.esc.stop="emit('close')"
        @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>
