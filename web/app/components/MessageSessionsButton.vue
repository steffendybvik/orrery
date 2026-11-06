<script setup lang="ts">
import {ChatBubbleLeftRightIcon} from '@heroicons/vue/24/outline'

// Message sessions from every page's header (ORR-937): opens the dialog that messages every listening session at once,
// shown while any session listens, as ⌘K's "Message sessions" is.
const {all, listening} = useMessageSessions()
const label = computed(() => `Message sessions (${listening.value.length} listening)`)
</script>

<template>
  <UiButton
      v-if="listening.length"
      variant="ghost"
      square
      class="shrink-0"
      :title="label"
      :aria-label="label"
      @click="all = true"
  >
    <ChatBubbleLeftRightIcon class="size-4" />
  </UiButton>
</template>
