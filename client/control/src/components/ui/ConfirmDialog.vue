<script setup lang="ts">
import { computed } from 'vue';
import { X, AlertTriangle } from 'lucide-vue-next';
import BaseButton from './BaseButton.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
}>(), {
  title: 'Confirm Action',
  confirmText: 'Confirm',
  cancelText: 'Cancel',
  variant: 'default',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const isOpen = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value),
});

function close() {
  isOpen.value = false;
  emit('cancel');
}

function confirm() {
  emit('confirm');
  isOpen.value = false;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="isOpen"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/50 backdrop-blur-sm"
          @click="close"
        />

        <!-- Modal -->
        <div class="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-md">
          <!-- Header -->
          <div class="flex items-start justify-between px-6 py-4 border-b border-border">
            <div class="flex items-center gap-3">
              <div
                v-if="variant === 'destructive'"
                class="flex-shrink-0 p-2 bg-destructive/10 rounded-full"
              >
                <AlertTriangle class="h-5 w-5 text-destructive" />
              </div>
              <h2 class="text-lg font-semibold text-foreground">
                {{ title }}
              </h2>
            </div>
            <button
              type="button"
              class="p-1 rounded-md hover:bg-accent transition-colors"
              @click="close"
            >
              <X class="h-5 w-5 text-muted-foreground" />
            </button>
          </div>

          <!-- Body -->
          <div class="px-6 py-4">
            <p class="text-foreground">
              {{ message }}
            </p>
          </div>

          <!-- Footer -->
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-muted/50">
            <BaseButton
              variant="outline"
              @click="close"
            >
              {{ cancelText }}
            </BaseButton>
            <BaseButton
              :variant="variant === 'destructive' ? 'destructive' : 'primary'"
              @click="confirm"
            >
              {{ confirmText }}
            </BaseButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .relative,
.modal-leave-active .relative {
  transition: transform 0.2s ease;
}

.modal-enter-from .relative,
.modal-leave-to .relative {
  transform: scale(0.95);
}
</style>
