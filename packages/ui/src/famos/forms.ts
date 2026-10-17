/**
 * What a form's plain modules (its value, its validator) share, without the components: they
 * are also checked and tested outside the browser.
 */
export * from './field-errors.js';

/** The repeat choices of `RepeatPicker`; `custom` marks a rule outside the presets. */
export type RepeatPreset = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom';
