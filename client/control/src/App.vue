<script setup lang="ts">
import { onMounted } from 'vue';
import { useFactcheckStore } from './stores/factcheck';
import PipelineControl from './components/PipelineControl.vue';
import ClaimList from './components/ClaimList.vue';
import ClaimDetail from './components/ClaimDetail.vue';
import TranscriptPane from './components/TranscriptPane.vue';

const store = useFactcheckStore();
onMounted(() => store.init());
</script>

<template>
  <!-- Login screen -->
  <div v-if="store.authRequired && !store.authenticated" class="flex items-center justify-center min-h-screen">
    <form @submit.prevent="store.login(($event.target as HTMLFormElement).querySelector('input')!.value)" class="bg-slate-900 p-8 rounded-xl w-96 space-y-4">
      <h1 class="text-xl font-bold">xalt-factcheck</h1>
      <p class="text-slate-400 text-sm">Enter control password to access the dashboard.</p>
      <input type="password" placeholder="Password" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
      <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white rounded py-2 text-sm font-medium">Sign In</button>
    </form>
  </div>

  <!-- Main dashboard -->
  <div v-else class="flex flex-col h-screen">
    <!-- Top bar -->
    <header class="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-bold tracking-wide">FACT CHECKER</h1>
        <span class="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-semibold">BETA</span>
      </div>
      <div class="flex items-center gap-4 text-sm">
        <span :class="store.sseConnected ? 'text-green-400' : 'text-red-400'" class="flex items-center gap-1">
          <span class="w-2 h-2 rounded-full" :class="store.sseConnected ? 'bg-green-400' : 'bg-red-400'"></span>
          {{ store.sseConnected ? 'Live' : 'Disconnected' }}
        </span>
        <span v-if="store.running" class="text-emerald-400 font-medium">Running</span>
        <span v-else class="text-slate-500">Stopped</span>
        <span class="text-slate-500">{{ store.claimsList.length }} claims</span>
      </div>
    </header>

    <!-- Main content -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Left panel: pipeline control + claims list -->
      <div class="w-96 border-r border-slate-800 flex flex-col overflow-hidden shrink-0">
        <PipelineControl />
        <ClaimList />
      </div>

      <!-- Center: Claim detail -->
      <div class="flex-1 overflow-y-auto">
        <ClaimDetail v-if="store.selectedClaim" />
        <div v-else class="flex items-center justify-center h-full text-slate-600">
          Select a claim to view details
        </div>
      </div>

      <!-- Right: Transcript -->
      <div class="w-80 border-l border-slate-800 shrink-0">
        <TranscriptPane />
      </div>
    </div>
  </div>
</template>
