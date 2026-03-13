<script setup lang="ts">
import { watch, onMounted, onUnmounted, computed } from 'vue';
import { X } from 'lucide-vue-next';

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | 'full' | 'settings';
  closable?: boolean;
  showFooter?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'xl',
  closable: true,
  showFooter: true,
});

const emit = defineEmits<{
  close: [];
}>();

const sizeClasses: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  full: 'max-w-[90vw]',
  settings: 'settings-modal',
};

const isSettingsSize = computed(() => props.size === 'settings');

function handleEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.closable) {
    emit('close');
  }
}

function handleBackdropClick() {
  if (props.closable) {
    emit('close');
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
});

onMounted(() => {
  window.addEventListener('keydown', handleEscape);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleEscape);
  document.body.style.overflow = '';
});

</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/40 backdrop-blur-sm"
          @click="handleBackdropClick"
        />

        <!-- Modal Container -->
        <Transition
          enter-active-class="duration-200 ease-out"
          enter-from-class="opacity-0 scale-95"
          enter-to-class="opacity-100 scale-100"
          leave-active-class="duration-150 ease-in"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-95"
        >
          <div
            v-if="open"
            :class="[
              'relative bg-background border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col',
              isSettingsSize ? 'settings-modal' : ['w-full max-h-[85vh]', sizeClasses[size]],
            ]"
          >
            <div class="flex flex-1 min-h-0">
              <!-- Optional Sidebar -->
              <div
                v-if="$slots.sidebar"
                class="w-60 flex-shrink-0 bg-card border-r border-border overflow-y-auto"
              >
                <slot name="sidebar" />
              </div>

              <!-- Main Content Area -->
              <div class="flex-1 flex flex-col min-w-0 bg-background relative">
                <!-- Close Button (positioned absolutely like Settings) -->
                <button
                  v-if="closable"
                  type="button"
                  class="absolute top-4 right-4 p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors z-10"
                  @click="emit('close')"
                >
                  <X class="h-5 w-5" />
                </button>

                <!-- Header -->
                <div class="px-8 pt-6 pb-4 pr-14">
                  <h2 class="text-2xl font-semibold text-foreground">
                    {{ title }}
                  </h2>
                  <p
                    v-if="subtitle"
                    class="text-sm text-muted-foreground mt-1"
                  >
                    {{ subtitle }}
                  </p>
                </div>

                <!-- Content -->
                <div class="flex-1 overflow-y-auto px-8 pb-6">
                  <slot />
                </div>

                <!-- Footer -->
                <div
                  v-if="showFooter && $slots.footer"
                  class="flex items-center justify-end gap-3 px-8 py-4 border-t border-border bg-muted/30"
                >
                  <slot name="footer" />
                </div>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-modal {
  width: 90vw;
  height: 85vh;
  max-width: 1600px;
  max-height: 1000px;
}
</style>
