import records from '@famos/ext-records/server';
import { extensionScopeContract } from '@famos/testing/contracts';
import extension from '../src/server/index.ts';

extensionScopeContract(extension, { with: [records] });
