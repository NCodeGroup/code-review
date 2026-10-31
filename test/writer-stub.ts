import { writerAssociations } from '../src/command.ts';
import type { WriterCheck } from '../src/writers.ts';

// Judges by the author's association alone, as the `/review` gate does, so a test needs no permission lookup.
export const byAssociation: WriterCheck = async (_login, association) => writerAssociations.has(association ?? '');
