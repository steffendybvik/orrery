<script setup lang="ts">
import {XMarkIcon} from '@heroicons/vue/16/solid'
import {Dialog, DialogPanel} from '@headlessui/vue'

// A picture shown larger over a dimmed page (plugins/image-view opens it), as big as the window allows. A click
// anywhere, Esc or the ✕ closes it; Headless UI's Dialog hands the focus back where it was.
const {image, close} = useImageView()
const frame = ref<HTMLElement | null>(null)
// Another page under it: the picture belongs to the one it opened on.
const route = useRoute()
watch(() => route.fullPath, close)
</script>

<template>
  <!-- Only the buttons are the panel, so a click on the picture or around it is outside it, and closes. Esc stops
       here, so a page's own Esc (back to the list) doesn't hear it too. -->
  <Dialog
      :open="!!image"
      :initial-focus="frame"
      class="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4 backdrop-blur-[2px] sm:p-8"
      :aria-label="image?.alt || 'Picture'"
      @close="close"
      @keydown.esc.stop="close"
  >
    <div ref="frame" tabindex="-1" class="flex size-full items-center justify-center focus:outline-none">
      <img v-if="image" :src="image.src" :alt="image.alt" class="max-h-full max-w-full animate-fade-up rounded-xl object-contain shadow-2xl ring-1 ring-white/10">
    </div>
    <DialogPanel class="absolute top-3 right-3 flex cursor-auto items-center gap-1.5">
      <a v-if="image" :href="image.src" target="_blank" rel="noopener" class="rounded-md bg-black/60 px-2.5 py-1 text-[12px] font-medium text-white ring-1 ring-white/25 hover:bg-black/75">Open original</a>
      <button type="button" aria-label="Close" class="grid size-7 place-items-center rounded-md bg-black/60 text-white ring-1 ring-white/25 hover:bg-black/75" @click="close">
        <XMarkIcon class="size-4" />
      </button>
    </DialogPanel>
  </Dialog>
</template>
