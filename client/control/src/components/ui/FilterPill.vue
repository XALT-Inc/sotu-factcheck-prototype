<script setup lang="ts">
/**
 * FilterPill - Individual filter pill button
 *
 * A pill-shaped button for filter options with:
 * - Active state (primary background)
 * - Inactive state (muted background)
 * - Optional icon
 * - Optional count badge
 *
 * Usage:
 * <FilterPill :active="isActive" @click="toggleFilter">
 *   All
 * </FilterPill>
 *
 * <FilterPill :active="showFavorites" :icon="Star" :count="5">
 *   Favorites
 * </FilterPill>
 */

import type { Component } from 'vue';

interface Props {
  /** Whether this filter is currently active */
  active?: boolean;
  /** Icon component to display */
  icon?: Component;
  /** Count/badge to show */
  count?: number | string;
  /** Variant for special styling (e.g., favorites with amber) */
  variant?: 'default' | 'favorites';
}

withDefaults(defineProps<Props>(), {
  active: false,
  variant: 'default',
});

const emit = defineEmits<{
  click: [];
}>();
</script>

<template>
  <button
    type="button"
    :class="[
      'px-3 py-1.5 text-sm font-medium rounded-full transition-all flex items-center gap-1.5',
      active
        ? variant === 'favorites'
          ? 'bg-amber-500 text-white'
          : 'bg-primary text-primary-foreground'
        : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
    ]"
    @click="emit('click')"
  >
    <component
      :is="icon"
      v-if="icon"
      :class="[
        'h-3.5 w-3.5',
        active && variant === 'favorites' ? 'fill-current' : ''
      ]"
    />
    <slot />
    <span
      v-if="count !== undefined"
      class="text-xs opacity-75"
    >({{ count }})</span>
  </button>
</template>
