<script setup lang="ts">
import type { Component } from 'vue';

interface Props {
  icon?: Component;
  title: string;
  description?: string;
}

defineProps<Props>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 px-4 text-center">
    <div
      v-if="icon"
      class="mb-4 p-3 bg-muted rounded-full"
    >
      <component
        :is="icon"
        class="h-8 w-8 text-muted-foreground"
      />
    </div>
    <h3 class="text-lg font-medium text-foreground mb-1">
      {{ title }}
    </h3>
    <p
      v-if="description"
      class="text-muted-foreground text-sm max-w-sm mb-4"
    >
      {{ description }}
    </p>
    <slot name="action" />
  </div>
</template>
