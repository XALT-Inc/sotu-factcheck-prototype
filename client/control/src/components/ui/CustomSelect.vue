<script setup lang="ts">
/**
 * CustomSelect - A styled dropdown component that replaces native <select> elements
 *
 * Features:
 * - Consistent styling with design system (light bg, amber highlight, checkmark)
 * - Optional search/filter functionality
 * - Keyboard navigation (Arrow keys, Enter, Escape)
 * - Click outside to close
 * - Supports custom value input (for searchable mode)
 * - Accessible with proper ARIA attributes
 */
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { ChevronDown, Check, Search } from 'lucide-vue-next';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

interface Props {
  modelValue?: string | number | null;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  label?: string;
  required?: boolean;
  searchable?: boolean;
  allowCustomValue?: boolean;
  customValueLabel?: string; // e.g., "Use" for "Use 42px"
  size?: 'sm' | 'md' | 'lg';
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  required: false,
  searchable: false,
  allowCustomValue: false,
  customValueLabel: 'Use',
  size: 'md',
});

const emit = defineEmits<{
  'update:modelValue': [value: string | number | null];
}>();

// State
const isOpen = ref(false);
const searchQuery = ref('');
const highlightedIndex = ref(-1);
const triggerRef = ref<HTMLButtonElement | null>(null);
const dropdownRef = ref<HTMLDivElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

// Computed
const selectedOption = computed(() => {
  return props.options.find(opt => opt.value === props.modelValue);
});

const displayValue = computed(() => {
  if (selectedOption.value) {
    return selectedOption.value.label;
  }
  if (props.modelValue !== null && props.modelValue !== undefined && props.modelValue !== '') {
    return String(props.modelValue);
  }
  return props.placeholder || 'Select...';
});

const filteredOptions = computed(() => {
  if (!props.searchable || !searchQuery.value) {
    return props.options;
  }
  const query = searchQuery.value.toLowerCase().trim();
  return props.options.filter(opt =>
    opt.label.toLowerCase().includes(query) ||
    String(opt.value).toLowerCase().includes(query)
  );
});

const showCustomValueOption = computed(() => {
  if (!props.allowCustomValue || !searchQuery.value.trim()) return false;
  const query = searchQuery.value.trim();
  // Don't show if query matches an existing option
  return !props.options.some(opt =>
    String(opt.value) === query || opt.label.toLowerCase() === query.toLowerCase()
  );
});

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'sm':
      return {
        trigger: 'px-2 py-1.5 text-xs',
        dropdown: 'py-1',
        option: 'px-3 py-2 text-xs',
        search: 'px-2 py-1.5 text-xs',
      };
    case 'lg':
      return {
        trigger: 'px-4 py-3 text-base',
        dropdown: 'py-2',
        option: 'px-4 py-3 text-base',
        search: 'px-4 py-3 text-base',
      };
    default:
      return {
        trigger: 'px-3 py-2 text-sm',
        dropdown: 'py-2',
        option: 'px-4 py-2.5 text-sm',
        search: 'px-3 py-2 text-sm',
      };
  }
});

// Methods
function toggle() {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    highlightedIndex.value = -1;
    searchQuery.value = '';
    nextTick(() => {
      if (props.searchable && searchInputRef.value) {
        searchInputRef.value.focus();
      }
    });
  }
}

function close() {
  isOpen.value = false;
  searchQuery.value = '';
  highlightedIndex.value = -1;
}

function selectOption(option: SelectOption) {
  if (option.disabled) return;
  emit('update:modelValue', option.value);
  close();
}

function selectCustomValue() {
  const value = searchQuery.value.trim();
  if (value) {
    // Try to parse as number if it looks like one
    const numValue = Number(value);
    emit('update:modelValue', isNaN(numValue) ? value : numValue);
    close();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (!isOpen.value) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      toggle();
    }
    return;
  }

  const options = filteredOptions.value.filter(opt => !opt.disabled);
  const maxIndex = options.length - 1 + (showCustomValueOption.value ? 1 : 0);

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      highlightedIndex.value = Math.min(highlightedIndex.value + 1, maxIndex);
      break;
    case 'ArrowUp':
      event.preventDefault();
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
      break;
    case 'Enter':
      event.preventDefault();
      if (highlightedIndex.value >= 0 && highlightedIndex.value < options.length) {
        selectOption(options[highlightedIndex.value]);
      } else if (showCustomValueOption.value && highlightedIndex.value === options.length) {
        selectCustomValue();
      } else if (props.allowCustomValue && searchQuery.value.trim()) {
        selectCustomValue();
      }
      break;
    case 'Escape':
      event.preventDefault();
      close();
      triggerRef.value?.focus();
      break;
    case 'Tab':
      close();
      break;
  }
}

function handleSearchInput(event: Event) {
  searchQuery.value = (event.target as HTMLInputElement).value;
  highlightedIndex.value = 0;
}

// Click outside handler
function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node;
  if (
    dropdownRef.value &&
    !dropdownRef.value.contains(target) &&
    triggerRef.value &&
    !triggerRef.value.contains(target)
  ) {
    close();
  }
}

function handleScroll() {
  if (isOpen.value) {
    close();
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  window.addEventListener('scroll', handleScroll, true);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  window.removeEventListener('scroll', handleScroll, true);
});
</script>

<template>
  <div class="relative">
    <!-- Label -->
    <label
      v-if="label"
      class="block text-xs text-muted-foreground mb-1"
    >
      {{ label }}
      <span
        v-if="required"
        class="text-destructive"
      >*</span>
    </label>

    <!-- Trigger Button -->
    <button
      ref="triggerRef"
      type="button"
      :disabled="disabled"
      :class="[
        'w-full flex items-center justify-between border rounded-md bg-background transition-colors',
        sizeClasses.trigger,
        disabled
          ? 'opacity-50 cursor-not-allowed border-border'
          : 'hover:border-primary/50 border-border',
        error ? 'border-destructive' : '',
        isOpen ? 'ring-2 ring-primary/50 border-primary' : '',
      ]"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="handleKeydown"
    >
      <span
        :class="[
          'truncate',
          !selectedOption && !props.modelValue ? 'text-muted-foreground' : 'text-foreground'
        ]"
      >
        {{ displayValue }}
      </span>
      <ChevronDown
        :class="[
          'h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ml-2',
          isOpen ? 'rotate-180' : ''
        ]"
      />
    </button>

    <!-- Dropdown Menu -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        :class="[
          'fixed bg-card border border-border rounded-xl shadow-xl overflow-hidden',
          sizeClasses.dropdown
        ]"
        :style="{
          zIndex: 9999,
          minWidth: triggerRef ? `${triggerRef.offsetWidth}px` : '200px',
          top: triggerRef ? `${triggerRef.getBoundingClientRect().bottom + 4}px` : '0',
          left: triggerRef ? `${triggerRef.getBoundingClientRect().left}px` : '0',
        }"
        role="listbox"
        @keydown="handleKeydown"
      >
        <!-- Search Input -->
        <div
          v-if="searchable"
          class="px-2 pb-2 border-b border-border"
        >
          <div class="relative">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              ref="searchInputRef"
              type="text"
              :value="searchQuery"
              :placeholder="allowCustomValue ? 'Search or type value...' : 'Search...'"
              :class="[
                'w-full pl-9 pr-3 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50',
                sizeClasses.search
              ]"
              @input="handleSearchInput"
              @keydown="handleKeydown"
            >
          </div>
        </div>

        <!-- Options List -->
        <div class="max-h-64 overflow-y-auto">
          <!-- Empty State -->
          <div
            v-if="filteredOptions.length === 0 && !showCustomValueOption"
            :class="['text-muted-foreground text-center', sizeClasses.option]"
          >
            No options found
          </div>

          <!-- Options -->
          <button
            v-for="(option, index) in filteredOptions"
            :key="option.value"
            type="button"
            role="option"
            :aria-selected="modelValue === option.value"
            :disabled="option.disabled"
            :class="[
              'w-full text-left flex items-center justify-between transition-colors',
              sizeClasses.option,
              option.disabled
                ? 'opacity-50 cursor-not-allowed'
                : modelValue === option.value
                  ? 'bg-primary/10 text-primary'
                  : highlightedIndex === index
                    ? 'bg-muted'
                    : 'text-foreground hover:bg-muted',
            ]"
            @click="selectOption(option)"
            @mouseenter="highlightedIndex = index"
          >
            <span class="truncate">{{ option.label }}</span>
            <Check
              v-if="modelValue === option.value"
              class="h-4 w-4 flex-shrink-0 ml-2"
            />
          </button>

          <!-- Custom Value Option -->
          <button
            v-if="showCustomValueOption"
            type="button"
            :class="[
              'w-full text-left flex items-center gap-2 text-primary transition-colors border-t border-border',
              sizeClasses.option,
              highlightedIndex === filteredOptions.length ? 'bg-muted' : 'hover:bg-muted',
            ]"
            @click="selectCustomValue"
            @mouseenter="highlightedIndex = filteredOptions.length"
          >
            <span>{{ customValueLabel }} "{{ searchQuery }}"</span>
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Error Message -->
    <p
      v-if="error"
      class="mt-1 text-xs text-destructive"
    >
      {{ error }}
    </p>
  </div>
</template>
