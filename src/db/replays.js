import crypto from 'crypto';
import { db } from './connection.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS game_records (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_name TEXT NOT NULL,
    round_no INTEGER NOT NULL,
    options_json TEXT NOT NULL,
    participants_json TEXT NOT NULL,
    initial_hands_json TEXT NOT NULL,
    bottom_json TEXT NOT NULL,
    landlord_seat INTEGER,
    base_score INTEGER,
    multiplier INTEGER,
    bomb_count INTEGER,
    result_json TEXT,
    actions_json TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  )
`);

const insertRecord = db.prepare(`
  INSERT INTO game_records (
    id, room_id, room_name, round_no, options_json, participants_json,
    initial_hands_json, bottom_json, actions_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getRecord = db.prepare('SELECT * FROM game_records WHERE id = ?');

const updateActions = db.prepare('UPDATE game_records SET actions_json = ? WHERE id = ?');

const finishRecordStmt = db.prepare(`
  UPDATE game_records
  SET landlord_seat = ?,
      base_score = ?,
      multiplier = ?,
      bomb_count = ?,
      result_json = ?,
      actions_json = ?,
      finished_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const listByUser = db.prepare(`
  SELECT id, room_name, round_no, participants_json, result_json, started_at, finished_at
  FROM game_records
  WHERE finished_at IS NOT NULL
    AND participants_json LIKE ?
  ORDER BY finished_at DESC
  LIMIT 50
`);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToReplay(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name,
    roundNo: row.round_no,
    options: parseJson(row.options_json, {}),
    participants: parseJson(row.participants_json, []),
    initialHands: parseJson(row.initial_hands_json, []),
    bottom: parseJson(row.bottom_json, []),
    landlordSeat: row.landlord_seat,
    baseScore: row.base_score,
    multiplier: row.multiplier,
    bombCount: row.bomb_count,
    result: parseJson(row.result_json, null),
    actions: parseJson(row.actions_json, []),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createGameRecord({ roomId, roomName, roundNo, options, participants, initialHands, bottom }) {
  const id = crypto.randomUUID();
  insertRecord.run(
    id,
    roomId,
    roomName,
    roundNo,
    JSON.stringify(options),
    JSON.stringify(participants),
    JSON.stringify(initialHands),
    JSON.stringify(bottom),
    JSON.stringify([{ type: 'start', at: Date.now() }]),
  );
  return id;
}

export function appendGameAction(recordId, action) {
  if (!recordId) return;
  const row = getRecord.get(recordId);
  if (!row) return;
  const actions = parseJson(row.actions_json, []);
  actions.push({ ...action, at: Date.now() });
  updateActions.run(JSON.stringify(actions), recordId);
}

export function finishGameRecord(recordId, { landlordSeat, baseScore, multiplier, bombCount, result }) {
  if (!recordId) return;
  const row = getRecord.get(recordId);
  if (!row) return;
  const actions = parseJson(row.actions_json, []);
  actions.push({ type: 'finish', result, at: Date.now() });
  finishRecordStmt.run(
    landlordSeat,
    baseScore,
    multiplier,
    bombCount,
    JSON.stringify(result),
    JSON.stringify(actions),
    recordId,
  );
}

export function listReplaysForUser(username) {
  return listByUser.all(`%"id":"${username}"%`).map((row) => {
    const replay = rowToReplay(row);
    return {
      id: replay.id,
      roomName: replay.roomName,
      roundNo: replay.roundNo,
      participants: replay.participants,
      result: replay.result,
      startedAt: replay.startedAt,
      finishedAt: replay.finishedAt,
    };
  });
}

export function getReplayForUser(recordId, username) {
  const replay = rowToReplay(getRecord.get(recordId));
  if (!replay) return null;
  if (!replay.participants.some((p) => p.id === username)) return null;
  return replay;
}
