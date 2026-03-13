<script setup lang="ts">
import { computed } from 'vue';
import { Loader2 } from 'lucide-vue-next';

interface Props {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  loading: false,
  disabled: false,
  fullWidth: false,
});

const classes = computed(() => {
  // Base styles - disabled shows grey (not blurred/opacity)
  const base = 'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed';

  // Disabled state classes - grey background and text instead of opacity
  const disabledClasses = 'disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-200';

  const variants = {
    primary: `bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-primary ${disabledClasses}`,
    secondary: `bg-secondary text-secondary-foreground hover:bg-secondary/80 focus:ring-secondary ${disabledClasses}`,
    outline: `border border-border bg-transparent hover:bg-accent hover:text-accent-foreground focus:ring-accent ${disabledClasses}`,
    ghost: `bg-transparent hover:bg-accent hover:text-accent-foreground focus:ring-accent ${disabledClasses}`,
    destructive: `bg-destructive text-destructive-foreground hover:bg-destructive/90 focus:ring-destructive ${disabledClasses}`,
  };

  const sizes = {
    sm: 'h-8 px-3 text-sm',
    md: 'h-10 px-4 text-sm',
    lg: 'h-12 px-6 text-base',
  };

  return [
    base,
    variants[props.variant],
    sizes[props.size],
    props.fullWidth ? 'w-full' : '',
  ].join(' ');
});
</script>

<template>
  <button
    :class="classes"
    :disabled="disabled || loading"
  >
    <Loader2
      v-if="loading"
      class="h-4 w-4 animate-spin"
    />
    <slot />
  </button>
</template>
