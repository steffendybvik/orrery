<script setup lang="ts">
// Asking before removing something, in place of what asked (docs/components.md): the question in the slot, then
// the danger button and Cancel. Stacked, the buttons share the width (a menu); `inline` puts it all on one line
// (a toolbar, a comment). `busy` disables both and says `busyAction` on the button. Esc cancels.
withDefaults(defineProps<{
    busy?: boolean
    action?: string
    busyAction?: string
    inline?: boolean
    size?: 'xs' | 'sm'
}>(), {action: 'Remove', busyAction: 'Removing…', size: 'sm'})
const emit = defineEmits<{confirm: [], cancel: []}>()
</script>

<template>
  <span v-if="inline" class="flex items-center gap-2" @keydown.esc.stop="emit('cancel')">
    <span class="text-muted"><slot /></span>
    <UiButton variant="danger" :size="size" :disabled="busy" @click="emit('confirm')">{{ busy ? busyAction : action }}</UiButton>
    <UiButton :size="size" :disabled="busy" @click="emit('cancel')">Cancel</UiButton>
  </span>
  <div v-else class="flex flex-col gap-2 text-xs" @keydown.esc.stop="emit('cancel')">
    <p class="text-muted"><slot /></p>
    <div class="flex gap-2">
      <UiButton variant="danger" :size="size" class="flex-1" :disabled="busy" @click="emit('confirm')">{{ busy ? busyAction : action }}</UiButton>
      <UiButton :size="size" class="flex-1" :disabled="busy" @click="emit('cancel')">Cancel</UiButton>
    </div>
  </div>
</template>
