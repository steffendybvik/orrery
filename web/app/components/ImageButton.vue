<script setup lang="ts">
import {PhotoIcon} from '@heroicons/vue/24/outline'

// The button beside a Markdown field that picks images from the computer (see useImageUpload).
const emit = defineEmits<{picked: [files: File[]]}>()
const picker = ref<HTMLInputElement>()

function onPick() {
    emit('picked', [...picker.value?.files ?? []])
    if (picker.value) picker.value.value = ''
}
</script>

<template>
  <button
      type="button"
      class="flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
      title="Add an image"
      aria-label="Add an image"
      @click="picker?.click()"
  ><PhotoIcon class="size-4" /></button>
  <input ref="picker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="hidden" @change="onPick">
</template>
