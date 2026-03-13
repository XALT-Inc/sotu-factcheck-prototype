<script setup lang="ts">
import { ref, watch } from 'vue';
import { Settings, Link, Package } from 'lucide-vue-next';
import { BaseButton, BaseInput, ModalLayout } from './ui';
import { useFactcheckStore } from '../stores/factcheck';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const store = useFactcheckStore();

const sections = [
  { key: 'General', label: 'General', icon: Settings, group: 'GENERAL' },
  { key: 'Source', label: 'Source', icon: Link, group: 'GENERAL' },
  { key: 'Asset', label: 'Asset', icon: Package, group: 'GENERAL' },
] as const;

type SectionKey = typeof sections[number]['key'];
const activeSection = ref<SectionKey>('General');

const eventName = ref('');
const description = ref('');
const youtubeUrl = ref('');
const speechContext = ref('');
const operatorNotes = ref('');
const error = ref('');
const creating = ref(false);

watch(() => props.modelValue, (open) => {
  if (open) {
    activeSection.value = 'General';
    eventName.value = '';
    description.value = '';
    youtubeUrl.value = '';
    speechContext.value = '';
    operatorNotes.value = '';
    error.value = '';
    creating.value = false;
  }
});

function close() {
  emit('update:modelValue', false);
}

async function create() {
  error.value = '';
  if (!youtubeUrl.value.trim()) {
    error.value = 'YouTube URL is required';
    activeSection.value = 'Source';
    return;
  }
  creating.value = true;
  const res = await store.startPipeline(youtubeUrl.value.trim(), {
    speechContext: speechContext.value.trim() || undefined,
    operatorNotes: operatorNotes.value.trim() || undefined,
  });
  creating.value = false;
  if (!res.ok) {
    error.value = (res.error as string) ?? 'Failed to create event';
    return;
  }
  close();
  if (res.runId) {
    store.openRun(res.runId as string);
  }
}
</script>

<template>
  <ModalLayout
    :open="modelValue"
    title="Create Factcheck Event"
    subtitle="Configure your new factcheck session"
    size="settings"
    @close="close"
  >
    <template #sidebar>
      <div class="py-5 flex flex-col shrink-0">
        <div class="px-5 mb-4">
          <span class="text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">GENERAL</span>
        </div>
        <nav class="px-3 space-y-1">
          <button
            v-for="section in sections"
            :key="section.key"
            @click="activeSection = section.key"
            :class="activeSection === section.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent'"
            class="w-full flex items-center gap-3 h-9 pl-3 rounded-lg text-sm font-medium transition-colors"
          >
            <component :is="section.icon" class="w-4 h-4 shrink-0" />
            {{ section.label }}
          </button>
        </nav>
      </div>
    </template>

    <!-- General section -->
    <div v-if="activeSection === 'General'" class="space-y-5">
      <div class="bg-card border border-border rounded-lg p-5 space-y-4">
        <h4 class="text-sm font-semibold text-foreground">Event Details</h4>
        <BaseInput v-model="eventName" label="Event Name" placeholder="CNN Town Hall 2026" />
        <div>
          <label class="block text-sm font-medium text-foreground mb-1.5">Description</label>
          <textarea
            v-model="description"
            placeholder="Live fact-checking session for..."
            rows="3"
            class="w-full bg-background border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors resize-none"
          />
        </div>
      </div>
    </div>

    <!-- Source section -->
    <div v-if="activeSection === 'Source'" class="space-y-5">
      <div class="bg-card border border-border rounded-lg p-5 space-y-4">
        <h4 class="text-sm font-semibold text-foreground">Source Configuration</h4>
        <BaseInput v-model="youtubeUrl" label="YouTube URL" placeholder="https://www.youtube.com/watch?v=..." />
        <div>
          <label class="block text-sm font-medium text-foreground mb-1.5">Speech Context</label>
          <textarea
            v-model="speechContext"
            placeholder="Names, topics, or context for better transcription..."
            rows="3"
            class="w-full bg-background border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors resize-none"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1.5">Operator Notes</label>
          <textarea
            v-model="operatorNotes"
            placeholder="Instructions for fact-check operators..."
            rows="3"
            class="w-full bg-background border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors resize-none"
          />
        </div>
      </div>
    </div>

    <!-- Asset section -->
    <div v-if="activeSection === 'Asset'" class="space-y-5">
      <div class="bg-card border border-border rounded-lg p-5 space-y-4">
        <h4 class="text-sm font-semibold text-foreground">Connected Asset</h4>
        <div class="bg-background border border-input rounded-lg px-3.5 py-2.5 text-sm text-muted-foreground">
          No assets connected (coming soon)
        </div>
      </div>
    </div>

    <template #footer>
      <p v-if="error" class="text-destructive text-sm mr-auto">{{ error }}</p>
      <BaseButton :loading="creating" @click="create">Create Event</BaseButton>
    </template>
  </ModalLayout>
</template>
