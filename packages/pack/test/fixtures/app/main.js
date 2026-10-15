// The app of the shared-modules test: it uses a little of what it shares, as the real app does.
import { useApp } from '@famos/ui/app';
import { mount } from 'svelte';
import { z } from 'zod';

export const used = [mount, z.object, useApp];
