<template>
  <!-- A page's own controls, under its header: how it's shown on the left, the filters on the right. -->
  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
    <div class="flex min-w-0 max-w-full items-center gap-2">
      <slot />
    </div>
    <div class="flex w-full min-w-0 items-center justify-end gap-2 sm:ml-auto sm:w-auto">
      <slot name="end" />
    </div>
  </div>
</template>
