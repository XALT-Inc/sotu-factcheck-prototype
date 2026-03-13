<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  padding?: 'none' | 'sm' | 'md' | 'lg' | boolean;
  hoverable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  padding: 'md',
  hoverable: false,
});

const paddingClasses: Record<string, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

const paddingClass = computed(() => {
  if (props.padding === false || props.padding === 'none') return '';
  if (props.padding === true) return paddingClasses.md;
  return paddingClasses[props.padding] || paddingClasses.md;
});
</script>

<template>
  <div
    :class="[
      'bg-card border border-border rounded-lg',
      paddingClass,
      hoverable ? 'hover:border-muted-foreground/50 transition-colors cursor-pointer' : '',
    ]"
  >
    <slot />
  </div>
</template>
