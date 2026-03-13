<script setup lang="ts">
import { Check, X, AlertTriangle, HelpCircle } from 'lucide-vue-next';

defineProps<{ verdict: string }>();

const colors: Record<string, string> = {
  true: 'bg-green-500/15 text-green-600 border-green-500/20',
  false: 'bg-red-500/15 text-red-600 border-red-500/20',
  misleading: 'bg-amber-500/15 text-amber-600 border-amber-500/20',
  unverified: 'bg-orange-500/15 text-orange-600 border-orange-500/20',
};

const icons: Record<string, typeof Check> = {
  true: Check,
  false: X,
  misleading: AlertTriangle,
  unverified: HelpCircle,
};
</script>

<template>
  <span :class="colors[verdict.toLowerCase()] ?? colors.unverified" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase border">
    <component :is="icons[verdict.toLowerCase()] ?? icons.unverified" class="w-3 h-3" />
    {{ verdict }}
  </span>
</template>
