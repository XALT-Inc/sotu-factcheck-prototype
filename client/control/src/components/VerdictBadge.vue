<script setup lang="ts">
defineProps<{ verdict: string }>();

const colors: Record<string, string> = {
  true: 'bg-green-900/50 text-green-400 border-green-700',
  false: 'bg-red-900/50 text-red-400 border-red-700',
  misleading: 'bg-amber-900/50 text-amber-400 border-amber-700',
  unverified: 'bg-orange-900/50 text-orange-400 border-orange-700',
};
</script>

<template>
  <span :class="colors[verdict.toLowerCase()] ?? colors.unverified" class="inline-flex px-2 py-0.5 rounded text-xs font-bold uppercase border">
    {{ verdict }}
  </span>
</template>
