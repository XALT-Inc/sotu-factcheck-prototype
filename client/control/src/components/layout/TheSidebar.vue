<script setup lang="ts">
import { ShieldCheck, Settings, HelpCircle, ChevronDown } from 'lucide-vue-next';
</script>

<template>
  <aside class="w-64 bg-card border-r border-border flex flex-col shrink-0">
    <!-- Workspace button -->
    <div class="h-[73px] border-b border-border flex items-center px-3">
      <div class="flex items-center gap-3 w-full bg-muted/50 rounded-lg h-12 px-3 cursor-pointer">
        <div class="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0">X</div>
        <span class="text-sm font-semibold text-foreground truncate flex-1">XALT Inc</span>
        <ChevronDown class="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
    </div>

    <!-- Nav items -->
    <nav class="flex-1 px-3 py-3 space-y-1">
      <div
        class="bg-primary text-primary-foreground flex items-center gap-3 h-9 pl-3 rounded-lg cursor-pointer transition-colors"
      >
        <ShieldCheck class="w-[18px] h-[18px] shrink-0" />
        <span class="text-sm font-medium">Factcheck</span>
      </div>
    </nav>

    <!-- Bottom icons -->
    <div class="px-3 py-3 flex items-center gap-2">
      <div class="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent cursor-pointer transition-colors">
        <Settings class="w-4 h-4" />
      </div>
      <div class="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground opacity-60 hover:bg-accent cursor-pointer transition-colors">
        <HelpCircle class="w-4 h-4" />
      </div>
    </div>
  </aside>
</template>
