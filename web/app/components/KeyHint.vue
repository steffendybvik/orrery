<template>
  <!-- A key to press means nothing on a touch screen, so there it isn't drawn (ORR-817); a dialog's esc closes there with a tap on the dimmed page. -->
  <kbd class="inline-flex h-4 min-w-4 items-center justify-center rounded bg-well px-1 font-mono text-[10px] text-muted ring-1 ring-line pointer-coarse:hidden"><slot /></kbd>
</template>
