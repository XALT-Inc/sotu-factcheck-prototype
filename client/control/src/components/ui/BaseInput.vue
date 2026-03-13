<script setup lang="ts">
import { computed, type Component } from 'vue';

interface Props {
  modelValue?: string | number;
  type?: 'text' | 'email' | 'password' | 'number' | 'search' | 'url' | 'tel';
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  label?: string;
  hint?: string;
  required?: boolean;
  icon?: Component;
  id?: string;
  name?: string;
}

const props = withDefaults(defineProps<Props>(), {
  type: 'text',
  disabled: false,
  required: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: string | number];
}>();

const inputClasses = computed(() => {
  const base = 'w-full py-2 rounded-lg border bg-background text-foreground placeholder-muted-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed';
  const padding = props.icon ? 'pl-10 pr-3' : 'px-3';

  if (props.error) {
    return `${base} ${padding} border-destructive focus:ring-destructive/50`;
  }

  return `${base} ${padding} border-border focus:ring-primary/50 focus:border-primary`;
});

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', props.type === 'number' ? Number(target.value) : target.value);
}
</script>

<template>
  <div class="space-y-1.5">
    <label
      v-if="label"
      :for="id"
      class="block text-sm font-medium text-foreground"
    >
      {{ label }}
      <span
        v-if="required"
        class="text-destructive"
      >*</span>
    </label>
    <div class="relative">
      <component
        :is="icon"
        v-if="icon"
        class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none"
      />
      <input
        :id="id"
        :name="name || id"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :required="required"
        :class="inputClasses"
        @input="handleInput"
      >
    </div>
    <p
      v-if="hint && !error"
      class="text-sm text-muted-foreground"
    >
      {{ hint }}
    </p>
    <p
      v-if="error"
      class="text-sm text-destructive"
    >
      {{ error }}
    </p>
  </div>
</template>
