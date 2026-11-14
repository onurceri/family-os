# Release fixture

`release-<version>.sqlite` is a database made by the last released FamilyOS with its own code:
every extension the image ships (`always` and `offered` of that tag's `extensions.json`) installed
and migrated, and the made-up family of the design sweep (`apps/e2e/support/sample-data.ts`: four
members, events, tasks, shopping lists, a chore, a home, a vehicle, a pet, a recipe, board notes,
an assistant conversation). `../release-fixture.test.ts` upgrades a copy of it with today's code.

It holds made-up data only. The server's key is the fixed test string `FIXTURE_SECRET` in the test
(`FAMOS_SECRET`), so no key file comes with it. Nothing else is sealed.

## Making the next one

After a release, from outside this repository's worktree (never from the code of `main`: the point
is a database the old code made):

1. `git worktree add --detach <scratch>/rel v<version>` and `cd` there; `npx pnpm@12.9.1 install --frozen-lockfile`
   and `npx pnpm@12.9.1 build`.
2. Add `apps/e2e/sweep/make-fixture.spec.ts` to that checkout (not committed anywhere):

   ```ts
   import { cpSync } from 'node:fs';
   import { setUpAndSignIn, test } from '../support/fixtures.ts';
   import { seedSampleFamily } from '../support/sample-data.ts';

   test('make the fixture', async ({ page, family, model }) => {
   	test.setTimeout(300_000);
   	page.setDefaultTimeout(20_000);
   	await setUpAndSignIn(page);
   	await seedSampleFamily(page, model);
   	await new Promise((r) => setTimeout(r, 4000)); // let the jobs settle
   	await family.stop(); // checkpoints the WAL
   	cpSync(family.dataDir, process.env.FIXTURE_OUT as string, { recursive: true });
   });
   ```

3. Run it with the sweep's setup, which installs every offered extension, and the fixed key (the
   `FAMOS_SECRET` of the test):

   ```bash
   FAMOS_SECRET='<FIXTURE_SECRET>' FIXTURE_OUT=<scratch>/out \
     npx pnpm@12.9.1 --filter @famos/e2e exec playwright test -c sweep.config.ts make-fixture
   ```

4. Make it one file and copy it here:

   ```bash
   cp <scratch>/out/famos.db apps/server/test/fixtures/release-<version>.sqlite
   sqlite3 apps/server/test/fixtures/release-<version>.sqlite \
     "pragma wal_checkpoint(truncate); pragma journal_mode=delete; vacuum;"
   rm -f apps/server/test/fixtures/*-shm apps/server/test/fixtures/*-wal
   ```

5. Point `FIXTURE` (and `FIXTURE_SECRET` if it changed) in `release-fixture.test.ts` at the new file,
   delete the old fixture, remove the scratch worktree (`git worktree remove`), and run
   `pnpm exec vitest run apps/server/test/release-fixture.test.ts`. If the made-up rows the test
   reads are gone from the sample family, change the test to read ones that are there.
