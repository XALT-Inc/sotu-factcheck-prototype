<script setup lang="ts">
interface Props {
  label: string;
  description?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  /** Stack vertically on small screens, horizontal on larger */
  responsive?: boolean;
  /** Always stack vertically */
  stacked?: boolean;
}

withDefaults(defineProps<Props>(), {
  responsive: true,
  stacked: false,
});
</script>

<template>
  <div
    :class="[
      'py-5 first:pt-0 last:pb-0',
      !stacked && 'border-b border-border last:border-b-0'
    ]"
  >
    <div
      :class="[
        stacked
          ? 'space-y-2'
          : responsive
            ? 'flex flex-col gap-2 sm:flex-row sm:gap-8'
            : 'flex flex-row gap-8'
      ]"
    >
      <!-- Label Column -->
      <div :class="[stacked ? '' : 'sm:w-1/3 flex-shrink-0']">
        <label class="block text-sm font-medium text-foreground">
          {{ label }}
          <span
            v-if="required"
            class="text-destructive ml-0.5"
          >*</span>
        </label>
        <p
          v-if="description"
          class="text-sm text-muted-foreground mt-0.5"
        >
          {{ description }}
        </p>
      </div>

      <!-- Input Column -->
      <div :class="[stacked ? '' : 'flex-1']">
        <slot />
        <p
          v-if="hint && !error"
          class="text-xs text-muted-foreground mt-1.5"
        >
          {{ hint }}
        </p>
        <p
          v-if="error"
          class="text-xs text-destructive mt-1.5"
        >
          {{ error }}
        </p>
      </div>
    </div>
  </div>
</template>
