<script setup lang="ts">
// A message to one listening session from ⌘K, sent as its card's box sends it (ORR-679). It closes once sent.
const {one} = useMessageSessions()
</script>

<template>
  <UiDialog :open="!!one" label="Message a session" @close="one = null">
    <div class="flex items-center gap-2 text-xs text-faint">
      <span>Only {{ one?.name }} hears this</span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>
    <SessionMessage v-if="one" :session="one" :project="one.project" @sent="one = null" />
  </UiDialog>
</template>
