import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { USER_SEED_FILE } from '../config.js';
import { db } from './connection.js';
import { players } from '../state.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const passwordHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, passwordHash };
}

export function verifyPassword(password, user) {
  const { passwordHash } = hashPassword(password, user.salt);
  const stored = Buffer.from(user.password_hash, 'hex');
  const input = Buffer.from(passwordHash, 'hex');
  return stored.length === input.length && crypto.timingSafeEqual(stored, input);
}

export function upsertRuntimePlayer(user) {
  const existing = players.get(user.username);
  const runtime = existing || {
    id: user.username,
    username: user.username,
    socketId: null,
    roomId: null,
  };
  runtime.name = user.name;
  players.set(user.username, runtime);
  return runtime;
}

export function loadRuntimePlayers() {
  const rows = db.prepare('SELECT username, name FROM users').all();
  rows.forEach((row) => upsertRuntimePlayer(row));
}

export function findUser(username) {
  return db.prepare('SELECT username, password_hash, salt, name FROM users WHERE username = ?').get(username);
}

export function updateUserName(username, name) {
  db.prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?').run(name, username);
}

function loadSeedUsers() {
  if (!existsSync(USER_SEED_FILE)) {
    console.warn(`未找到账号种子文件: ${USER_SEED_FILE}`);
    return [];
  }
  const raw = readFileSync(USER_SEED_FILE, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.users)) return [];
  return data.users
    .map((user) => ({
      username: String(user.username || '').trim().toLowerCase(),
      password: String(user.password || ''),
      name: String(user.name || user.username || '').trim(),
    }))
    .filter((user) => user.username && user.password && user.name);
}

function seedDefaultAccounts() {
  const seedUsers = loadSeedUsers();
  if (!seedUsers.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, salt, name)
    VALUES (?, ?, ?, ?)
  `);
  for (const user of seedUsers) {
    const { salt, passwordHash } = hashPassword(user.password);
    insert.run(user.username, passwordHash, salt, user.name);
  }
}

export function initUsers() {
  seedDefaultAccounts();
  loadRuntimePlayers();
}
