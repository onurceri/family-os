import { expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember, signInAs } from '../support/members.ts';

test('a note goes up on the board, changes paper, is seen by the family on Today, is moved, pinned and taken down', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	await createMember(page, {
		name: 'Ece',
		role: 'member',
		email: 'ece@example.com',
		password: 'another horse battery',
	});
	await createMember(page, {
		name: 'Misafir',
		role: 'guest',
		email: 'misafir@example.com',
		password: 'a guest of the house',
	});

	// An empty board invites a note.
	await page.goto('/board');
	await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
	await expect(page.getByText('Nothing on the board yet.')).toBeVisible();
	await expect(
		page.getByText('Leave a note for the family: a reminder, a message, a thank-you.'),
	).toBeVisible();

	// Write on the first tile: the tile becomes the paper. Paper 3, until tomorrow.
	await page.getByRole('button', { name: 'Write a note…' }).click();
	const composer = page.getByTestId('composer');
	await composer.getByLabel('Your note').fill('Dinner is at 7,\nbring the bread');
	await composer.getByRole('radio', { name: 'Paper 3' }).check({ force: true });
	await composer.getByLabel('Stays on the board').selectOption('tomorrow');
	await composer.getByRole('button', { name: 'Put it up' }).click();
	await expect(page.getByText('Your note is on the board')).toBeVisible();

	const note = page.getByTestId('note').filter({ hasText: 'Dinner is at 7,' });
	await expect(note).toBeVisible();
	await expect(note).toHaveAttribute('data-paper', 'note-3');
	await expect(note).toContainText('Until tomorrow');
	await expect(page.getByText('Nothing on the board yet.')).toHaveCount(0);

	// The paper can change later.
	await note.getByRole('button', { name: 'Actions for this note' }).click();
	await note.getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByTestId('composer').getByRole('radio', { name: 'Paper 5' }).check({ force: true });
	await page.getByTestId('composer').getByRole('button', { name: 'Save' }).click();
	await expect(note).toHaveAttribute('data-paper', 'note-5');

	// A second member sees it on the board and on Today.
	const ece = await signInAs(browser, family, {
		email: 'ece@example.com',
		password: 'another horse battery',
	});
	await ece.page.goto('/');
	const card = ece.page.getByTestId('board-card');
	await expect(card).toContainText('Dinner is at 7,');
	await ece.page.goto('/board');
	const eceNote = ece.page.getByTestId('note').filter({ hasText: 'Dinner is at 7,' });
	await expect(eceNote).toBeVisible();
	// Looking at it marks it seen: the admin's board says who has seen it.
	await expect(note.getByTestId('note-seen')).toHaveText('Seen by Ece');

	// A newer note comes first; the author drags the older one before it, and it stays there.
	await page.getByRole('button', { name: 'Write a note…' }).click();
	await page.getByTestId('composer').getByLabel('Your note').fill('Bins go out tonight');
	await page.getByTestId('composer').getByRole('button', { name: 'Put it up' }).click();
	const notes = page.getByTestId('note');
	await expect(notes.first()).toContainText('Bins go out tonight');
	const from = await note.boundingBox();
	const to = await notes.first().boundingBox();
	if (!from || !to) throw new Error('the notes are not on the page');
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 12 });
	await expect(page.getByTestId('drop-gap')).toBeVisible();
	await page.mouse.up();
	await expect(notes.first()).toContainText('Dinner is at 7,');
	await page.reload();
	await expect(notes.first()).toContainText('Dinner is at 7,');
	await expect(ece.page.getByTestId('note').first()).toContainText('Dinner is at 7,');

	// The menu moves a note too (for keyboards and screen readers).
	await note.getByRole('button', { name: 'Actions for this note' }).click();
	await expect(note.getByRole('menuitem', { name: 'Move earlier' })).toHaveCount(0);
	await note.getByRole('menuitem', { name: 'Move later' }).click();
	await expect(notes.first()).toContainText('Bins go out tonight');
	await page.reload();
	await expect(notes.first()).toContainText('Bins go out tonight');
	await notes
		.filter({ hasText: 'Bins go out tonight' })
		.getByRole('button', { name: 'Actions for this note' })
		.click();
	await notes
		.filter({ hasText: 'Bins go out tonight' })
		.getByRole('menuitem', { name: 'Take down', exact: true })
		.click();
	await page.getByRole('button', { name: 'Tap again to take down' }).click();
	await expect(notes).toHaveCount(1);

	// Someone else's note has no actions for a member; the admin pins it.
	await expect(eceNote.getByRole('button', { name: 'Actions for this note' })).toHaveCount(0);

	await note.getByRole('button', { name: 'Actions for this note' }).click();
	await note.getByRole('menuitem', { name: 'Pin', exact: true }).click();
	await expect(note.getByText('Pinned', { exact: true })).toBeAttached();
	await expect(eceNote.getByText('Pinned', { exact: true })).toBeAttached();

	// A guest reads the board but cannot write on it.
	const guest = await signInAs(browser, family, {
		email: 'misafir@example.com',
		password: 'a guest of the house',
	});
	await guest.page.goto('/board');
	await expect(guest.page.getByText('Dinner is at 7,')).toBeVisible();
	await expect(guest.page.getByRole('button', { name: 'Write a note…' })).toHaveCount(0);
	await guest.context.close();

	// The author takes it down with a second tap; the other board follows.
	await note.getByRole('button', { name: 'Actions for this note' }).click();
	await note.getByRole('menuitem', { name: 'Take down', exact: true }).click();
	await note.getByRole('button', { name: 'Tap again to take down' }).click();
	await expect(page.getByText('Note taken down')).toBeVisible();
	await expect(page.getByTestId('note')).toHaveCount(0);
	await expect(eceNote).toHaveCount(0);
	await ece.context.close();
});
