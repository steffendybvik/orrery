<script setup lang="ts">
// The border between two panes side by side (docs/components.md), dragged to resize the pane before it. `v-model` is
// that pane's width in pixels; it stays at least `min`, and leaves the pane after it at least `keep`. Double-click puts
// it back to `initial`. It's a focusable separator: the arrows nudge it, Shift by more, and Home and End go to the ends.
const props = withDefaults(defineProps<{
    initial: number
    label: string
    min?: number
    keep?: number
}>(), {min: 240, keep: 320})
const width = defineModel<number>({required: true})

const handle = ref<HTMLElement>()
const dragging = ref(false)
const max = ref(props.initial)

/** The most it can be, from what the two panes have between them now. */
function measure() {
    const el = handle.value
    max.value = el?.parentElement ? Math.max(props.min, el.parentElement.clientWidth - el.offsetWidth - props.keep) : props.initial
    return max.value
}
const clamp = (to: number) => Math.round(Math.min(Math.max(to, props.min), measure()))
onMounted(measure)

let startX = 0
let startWidth = 0
function down(event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    handle.value?.setPointerCapture(event.pointerId)
    startX = event.clientX
    // What shows, which a narrower window may have held below the value.
    startWidth = handle.value?.previousElementSibling?.getBoundingClientRect().width ?? width.value
    dragging.value = true
}
function move(event: PointerEvent) {
    if (dragging.value) width.value = clamp(startWidth + event.clientX - startX)
}
function up(event: PointerEvent) {
    if (!dragging.value) return
    dragging.value = false
    handle.value?.releasePointerCapture(event.pointerId)
}
// The cursor and no selecting text while it drags, wherever the pointer goes.
watch(dragging, on => {
    document.documentElement.classList.toggle('cursor-col-resize', on)
    document.documentElement.classList.toggle('select-none', on)
})
onBeforeUnmount(() => {
    document.documentElement.classList.remove('cursor-col-resize', 'select-none')
})

function key(event: KeyboardEvent) {
    const step = event.shiftKey ? 64 : 16
    const to = {ArrowLeft: width.value - step, ArrowRight: width.value + step, Home: props.min, End: Infinity}[event.key]
    if (to === undefined) return
    event.preventDefault()
    width.value = clamp(to)
}
</script>

<template>
  <div
      ref="handle"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="label"
      :aria-valuenow="width"
      :aria-valuemin="min"
      :aria-valuemax="max"
      title="Drag to resize, double-click to reset"
      class="group relative z-30 w-px shrink-0 cursor-col-resize touch-none bg-line outline-none"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @lostpointercapture="dragging = false"
      @dblclick="width = initial"
      @keydown="key"
      @focus="measure"
  >
    <!-- A wider grip than the line it draws, and a subtle highlight on hover, focus and while dragging. -->
    <span class="absolute inset-y-0 -left-1 -right-1" aria-hidden="true" />
    <span
        class="pointer-events-none absolute inset-y-0 -left-px -right-px transition-colors group-hover:bg-accent-fill/40 group-focus-visible:bg-accent-fill"
        :class="{'bg-accent-fill/60': dragging}"
        aria-hidden="true"
    />
  </div>
</template>
