<script setup lang="ts">
/**
 * FormFooter - Persistent footer with Save/Cancel buttons
 *
 * Use at the bottom of forms and creation flows to provide
 * consistent action button placement (cancel left, primary right).
 *
 * Can be sticky (stays at bottom of viewport) or static.
 */
import BaseButton from './BaseButton.vue';

interface Props {
  /** Text for the primary action button */
  saveLabel?: string;
  /** Text for the cancel button */
  cancelLabel?: string;
  /** Show loading spinner on save button */
  saving?: boolean;
  /** Disable save button */
  saveDisabled?: boolean;
  /** Hide cancel button entirely */
  hideCancel?: boolean;
  /** Make footer sticky at bottom of viewport */
  sticky?: boolean;
  /** Primary button variant */
  saveVariant?: 'primary' | 'destructive';
}

withDefaults(defineProps<Props>(), {
  saveLabel: 'Save',
  cancelLabel: 'Cancel',
  saving: false,
  saveDisabled: false,
  hideCancel: false,
  sticky: true,
  saveVariant: 'primary',
});

const emit = defineEmits<{
  (e: 'save'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <div
    :class="[
      'bg-background border-t border-border px-6 py-4 flex items-center justify-end gap-3',
      sticky ? 'sticky bottom-0 z-10' : ''
    ]"
  >
    <!-- Optional slot for left-aligned content (e.g., delete button, status) -->
    <div class="flex-1">
      <slot name="left" />
    </div>

    <!-- Action buttons - cancel left, save right -->
    <BaseButton
      v-if="!hideCancel"
      variant="outline"
      :disabled="saving"
      @click="emit('cancel')"
    >
      {{ cancelLabel }}
    </BaseButton>

    <BaseButton
      :variant="saveVariant"
      :loading="saving"
      :disabled="saveDisabled || saving"
      @click="emit('save')"
    >
      {{ saveLabel }}
    </BaseButton>

    <!-- Optional slot for additional buttons -->
    <slot name="extra" />
  </div>
</template>
