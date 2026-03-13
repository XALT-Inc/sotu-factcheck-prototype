<script setup lang="ts">
import TheHeader from './TheHeader.vue';
import TheSidebar from './TheSidebar.vue';
</script>

<template>
  <div class="flex flex-col h-screen">
    <TheHeader />
    <div class="flex flex-1 overflow-hidden">
      <TheSidebar />
      <main class="flex-1 overflow-hidden flex flex-col">
        <slot />
      </main>
    </div>
  </div>
</template>
