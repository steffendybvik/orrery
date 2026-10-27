<script setup lang="ts">
import {XMarkIcon} from '@heroicons/vue/16/solid'

// A picture shown larger over a dimmed page (plugins/image-view opens it), as big as the window allows. A click
// anywhere, Esc or the ✕ closes it; focus goes back where it was.
const {image, close} = useImageView()
const root = ref<HTMLElement | null>(null)
let back: HTMLElement | null = null
watch(image, (now, was) => {
    if (now && !was) {
        back = document.activeElement as HTMLElement | null
        nextTick(() => root.value?.focus())
    } else if (!now && was) back?.focus({preventScroll: true})
})
// Another page under it: the picture belongs to the one it opened on.
const route = useRoute()
watch(() => route.fullPath, close)
</script>

<template>
  <Teleport to="body">
    <div
        v-if="image"
        ref="root"
        class="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4 backdrop-blur-[2px] focus:outline-none sm:p-8"
        role="dialog"
        aria-modal="true"
        :aria-label="image.alt || 'Picture'"
        tabindex="-1"
        @click="close"
        @keydown.esc.stop="close"
    >
      <img :src="image.src" :alt="image.alt" class="max-h-full max-w-full animate-fade-up rounded-xl object-contain shadow-2xl ring-1 ring-white/10">
      <div class="absolute top-3 right-3 flex items-center gap-1.5" @click.stop>
        <a :href="image.src" target="_blank" rel="noopener" class="rounded-md bg-black/60 px-2.5 py-1 text-[12px] font-medium text-white ring-1 ring-white/25 hover:bg-black/75">Open original</a>
        <button type="button" aria-label="Close" class="grid size-7 place-items-center rounded-md bg-black/60 text-white ring-1 ring-white/25 hover:bg-black/75" @click="close">
          <XMarkIcon class="size-4" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
