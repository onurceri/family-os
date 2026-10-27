import './compat';
import { bootGuard } from '#lib/boot-failure.svelte.js';

bootGuard.listen(window);
