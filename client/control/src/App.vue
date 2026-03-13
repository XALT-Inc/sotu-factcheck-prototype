<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useFactcheckStore } from './stores/factcheck';
import { BaseButton, BaseInput, BaseCard } from './components/ui';
import AppShell from './components/layout/AppShell.vue';
import EventList from './components/EventList.vue';
import FactcheckPanel from './components/FactcheckPanel.vue';
import CreateEditEventModal from './components/CreateEditEventModal.vue';

const store = useFactcheckStore();
const showCreateModal = ref(false);
const password = ref('');

onMounted(() => store.init());
</script>

<template>
  <!-- Login screen -->
  <div v-if="store.authRequired && !store.authenticated" class="flex items-center justify-center min-h-screen bg-background">
    <BaseCard padding="lg" class="w-96">
      <form @submit.prevent="store.login(password)" class="space-y-4">
        <h1 class="text-xl font-bold text-foreground">XALT</h1>
        <p class="text-sm font-medium text-foreground">Fact-Check Control</p>
        <p class="text-muted-foreground text-sm">Enter control password to access the dashboard.</p>
        <BaseInput v-model="password" type="password" placeholder="Password" />
        <BaseButton type="submit" full-width>Sign In</BaseButton>
      </form>
    </BaseCard>
  </div>

  <!-- Main app -->
  <AppShell v-else>
    <EventList v-if="store.activeView === 'list'" @create="showCreateModal = true" />
    <FactcheckPanel v-else />
  </AppShell>

  <CreateEditEventModal v-model="showCreateModal" />
</template>
