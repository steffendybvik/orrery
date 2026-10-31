<script setup lang="ts">
// A page or panel with nothing to show yet (docs/components.md): the spinner in the middle of it. It comes in a moment
// late, so an answer that's nearly there doesn't flash it.
</script>

<template>
  <div class="grid animate-appear place-items-center px-4 py-24 text-lg text-faint" role="status" aria-label="Loading">
    <UiSpinner />
  </div>
</template>
