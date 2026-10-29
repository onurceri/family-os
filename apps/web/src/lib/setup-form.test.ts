import { describe, expect, it } from 'vitest';
import { checkSetup, serverSetupErrors } from './setup-form.js';

const valid = {
	familyName: '',
	displayName: 'Deniz',
	email: 'deniz@example.com',
	password: 'long enough password',
	setupCode: 'abc123',
};

describe('checking the setup form', () => {
	it('passes valid fields and trims names', () => {
		const { errors, body } = checkSetup(
			{ ...valid, displayName: '  Deniz ', familyName: ' The Novaks ' },
			true,
		);
		expect(errors).toEqual({});
		expect(body).toMatchObject({
			displayName: 'Deniz',
			familyName: 'The Novaks',
			setupCode: 'abc123',
		});
	});

	it('leaves out an empty family name and the code when none is asked for', () => {
		const { body } = checkSetup({ ...valid, familyName: '   ' }, false);
		expect(body).not.toHaveProperty('familyName');
		expect(body).not.toHaveProperty('setupCode');
	});

	it('refuses a name of spaces, a bad email, a short password and a missing code', () => {
		const { errors } = checkSetup(
			{ ...valid, displayName: '   ', email: 'not an email', password: 'short', setupCode: ' ' },
			true,
		);
		expect(errors).toEqual({
			displayName: 'app:setup_name_required',
			email: 'app:setup_email_invalid',
			password: 'app:setup_password_short',
			setupCode: 'app:setup_code_missing',
		});
	});

	it('says a value is too long when it is', () => {
		expect(checkSetup({ ...valid, password: 'x'.repeat(201) }, false).errors).toEqual({
			password: 'app:field_too_long',
		});
	});
});

describe('a refused setup request', () => {
	it('names the fields the server refused', () => {
		const details = { errors: [], properties: { displayName: { errors: ['Too small'] } } };
		expect(serverSetupErrors(details)).toEqual({ displayName: 'app:setup_name_required' });
	});

	it('names nothing for fields the form does not have, or no details', () => {
		expect(serverSetupErrors({ properties: { locale: { errors: ['x'] } } })).toEqual({});
		expect(serverSetupErrors(undefined)).toEqual({});
	});
});
