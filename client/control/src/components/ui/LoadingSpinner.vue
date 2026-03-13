<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
}

withDefaults(defineProps<Props>(), {
  size: 'md',
});

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 py-8">
    <Loader2 :class="['animate-spin text-primary', sizeClasses[size]]" />
    <p
      v-if="text"
      class="text-sm text-muted-foreground"
    >
      {{ text }}
    </p>
  </div>
</template>
