<script lang="ts">
	import { todayIn } from '@famos/time';
	import type { DraftEditorProps } from '@famos/ui/slots';
	import { untrack } from 'svelte';
	import type { TaskInput } from '../contract/index.js';
	import TaskForm from './TaskForm.svelte';
	import { taskFormFrom, taskInputFrom } from './task-form.js';

	/** Edits a proposed task inside the Inbox draft card. */
	let { input, context, uncertain, onchange }: DraftEditorProps<TaskInput> = $props();
	// The draft card owns the input from here on; the form is seeded once.
	let value = $state(untrack(() => taskFormFrom(input)));
	$effect(() => onchange(taskInputFrom(value)));
</script>

<TaskForm bind:value {uncertain} idPrefix="draft-task" />
