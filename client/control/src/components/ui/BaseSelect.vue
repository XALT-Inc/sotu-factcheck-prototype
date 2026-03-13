<script setup lang="ts">
/**
 * BaseSelect - Wrapper around CustomSelect for backward compatibility
 *
 * This component maintains the same API as the original BaseSelect
 * but uses the new CustomSelect component internally for consistent styling.
 */
import CustomSelect, { type SelectOption } from './CustomSelect.vue';

interface Option {
  value: string | number;
  label: string;
  disabled?: boolean;
}

interface Props {
  modelValue?: string | number | null;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  label?: string;
  required?: boolean;
  searchable?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

withDefaults(defineProps<Props>(), {
  disabled: false,
  required: false,
  searchable: false,
  size: 'md',
});

const emit = defineEmits<{
  'update:modelValue': [value: string | number | null];
}>();

function handleUpdate(value: string | number | null) {
  emit('update:modelValue', value);
}
</script>

<template>
  <CustomSelect
    :model-value="modelValue"
    :options="options as SelectOption[]"
    :placeholder="placeholder"
    :disabled="disabled"
    :error="error"
    :label="label"
    :required="required"
    :searchable="searchable"
    :size="size"
    @update:model-value="handleUpdate"
  />
</template>
