import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export const PORT = process.env.PORT || 3000;

export const DB_DIR = path.join(ROOT_DIR, 'data');
export const DB_FILE = path.join(DB_DIR, 'doudizhu.sqlite');
export const USER_SEED_FILE = path.join(DB_DIR, 'users.seed.json');

export const TURN_SECONDS = 30;
export const NO_FOLLOW_SECONDS = 5;
