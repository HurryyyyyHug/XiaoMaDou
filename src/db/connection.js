import { mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_DIR, DB_FILE } from '../config.js';

mkdirSync(DB_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);
