<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'destructive' | 'info' | 'outline';
  size?: 'sm' | 'md';
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'default',
  size: 'sm',
});

const classes = computed(() => {
  const base = 'inline-flex items-center gap-1 font-medium rounded-full';

  const variants: Record<string, string> = {
    default: 'bg-muted text-muted-foreground',
    success: 'bg-green-500/15 text-green-600',
    warning: 'bg-yellow-500/15 text-yellow-600',
    error: 'bg-red-500/15 text-red-600',
    destructive: 'bg-red-500/15 text-red-600',
    info: 'bg-blue-500/15 text-blue-600',
    outline: 'border border-border text-muted-foreground',
  };

  const sizes = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
  };

  return [base, variants[props.variant], sizes[props.size]].join(' ');
});
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
