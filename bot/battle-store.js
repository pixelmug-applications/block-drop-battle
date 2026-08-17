import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VALID_STATES = new Set(["join", "ready", "go", "playing", "finished"]);

export class BattleStore {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS battle_players (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL DEFAULT '',
        device_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        slot_id TEXT NOT NULL DEFAULT '',
        device_name TEXT NOT NULL DEFAULT '',
        game_state TEXT NOT NULL DEFAULT 'join',
        result TEXT,
        lines INTEGER NOT NULL DEFAULT 0,
        round_id TEXT NOT NULL DEFAULT '',
        last_event_trans_id TEXT NOT NULL DEFAULT '',
        last_event_message_id TEXT NOT NULL DEFAULT '',
        pending_command TEXT NOT NULL DEFAULT '',
        pending_command_id TEXT NOT NULL DEFAULT '',
        command_acked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id),
        UNIQUE (chat_id, device_id),
        UNIQUE (chat_id, slot)
      );
      CREATE TABLE IF NOT EXISTS battle_device_routes (
        device_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        activated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS battle_group_users (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS battle_matches (
        chat_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        player_a_id TEXT NOT NULL,
        player_b_id TEXT NOT NULL,
        winner_id TEXT NOT NULL,
        loser_id TEXT NOT NULL,
        player_a_lines INTEGER NOT NULL DEFAULT 0,
        player_b_lines INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, round_id)
      );
      CREATE INDEX IF NOT EXISTS battle_matches_chat_players
        ON battle_matches (chat_id, player_a_id, player_b_id);
      CREATE INDEX IF NOT EXISTS battle_matches_chat_finished
        ON battle_matches (chat_id, finished_at DESC);
    `);
  }

  replaceBindings(chatId, players, now = Date.now()) {
    const id = required(chatId, "chatId");
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("Battle requires exactly two bound players");
    }
    if (new Set(players.map((item) => required(item.userId, "userId"))).size !== 2) {
      throw new Error("The two devices must belong to different users");
    }
    if (new Set(players.map((item) => required(item.deviceId, "deviceId"))).size !== 2) {
      throw new Error("Battle requires two different devices");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM battle_players WHERE chat_id = ?").run(id);
      const insert = this.db.prepare(`
        INSERT INTO battle_players (
          chat_id, user_id, user_name, device_id, slot, slot_id,
          device_name, game_state, result, lines, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'join', NULL, 0, ?)
      `);
      for (const player of players) {
        insert.run(
          id,
          String(player.userId),
          String(player.userName || ""),
          String(player.deviceId),
          Number(player.slot),
          String(player.slotId || ""),
          String(player.deviceName || ""),
          now,
        );
      }
      this.removeOrphanedRoutes(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.players(id);
  }

  replaceSnapshot(chatId, players, now = Date.now()) {
    const id = required(chatId, "chatId");
    const items = Array.isArray(players) ? players : [];
    if (items.length > 2) throw new Error("Battle has more than two bound devices");
    if (new Set(items.map((item) => required(item.userId, "userId"))).size !== items.length) {
      throw new Error("Each bound slot must belong to a different user");
    }
    if (new Set(items.map((item) => required(item.deviceId, "deviceId"))).size !== items.length) {
      throw new Error("Each bound slot must contain a different device");
    }

    const previous = new Map(this.players(id).map((item) => [item.user_id, item]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM battle_players WHERE chat_id = ?").run(id);
      const insert = this.db.prepare(`
        INSERT INTO battle_players (
          chat_id, user_id, user_name, device_id, slot, slot_id,
          device_name, game_state, result, lines, round_id,
          last_event_trans_id, last_event_message_id,
          pending_command, pending_command_id, command_acked, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const player of items) {
        const old = previous.get(String(player.userId));
        const unchanged = old
          && old.device_id === String(player.deviceId)
          && Number(old.slot) === Number(player.slot);
        insert.run(
          id,
          String(player.userId),
          String(player.userName || ""),
          String(player.deviceId),
          Number(player.slot),
          String(player.slotId || ""),
          String(player.deviceName || ""),
          unchanged ? old.game_state : "join",
          unchanged ? old.result : null,
          unchanged ? old.lines : 0,
          unchanged ? old.round_id : "",
          unchanged ? old.last_event_trans_id : "",
          unchanged ? old.last_event_message_id : "",
          unchanged ? old.pending_command : "",
          unchanged ? old.pending_command_id : "",
          unchanged ? old.command_acked : 0,
          now,
        );
      }
      this.removeOrphanedRoutes(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.players(id);
  }

  upsertBinding(chatId, player, now = Date.now()) {
    const id = required(chatId, "chatId");
    const userId = required(player.userId, "userId");
    const deviceId = required(player.deviceId, "deviceId");
    const slot = Number(player.slot);
    if (slot !== 1 && slot !== 2) throw new Error("Battle device slot must be 1 or 2");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        DELETE FROM battle_players
        WHERE chat_id = ? AND device_id = ? AND user_id <> ?
      `).run(id, deviceId, userId);
      this.db.prepare(`
        INSERT INTO battle_players (
          chat_id, user_id, user_name, device_id, slot, slot_id,
          device_name, game_state, result, lines, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'join', NULL, 0, ?)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          user_name = excluded.user_name,
          device_id = excluded.device_id,
          slot = excluded.slot,
          slot_id = excluded.slot_id,
          device_name = excluded.device_name,
          game_state = 'join',
          result = NULL,
          lines = 0,
          updated_at = excluded.updated_at
      `).run(
        id,
        userId,
        String(player.userName || ""),
        deviceId,
        slot,
        String(player.slotId || ""),
        String(player.deviceName || ""),
        now,
      );
      this.removeOrphanedRoutes(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.playerForUser(id, userId);
  }

  removeUser(chatId, userId) {
    const id = String(chatId || "");
    const uid = String(userId || "");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changes = Number(this.db.prepare(`
        DELETE FROM battle_players WHERE chat_id = ? AND user_id = ?
      `).run(id, uid).changes);
      this.removeOrphanedRoutes(id);
      this.db.exec("COMMIT");
      return changes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  players(chatId) {
    return this.db.prepare(`
      SELECT chat_id, user_id, user_name, device_id, slot, slot_id,
             device_name, game_state, result, lines, round_id,
             last_event_trans_id, last_event_message_id,
             pending_command, pending_command_id, command_acked, updated_at
      FROM battle_players WHERE chat_id = ? ORDER BY slot
    `).all(String(chatId || ""));
  }

  playerForUser(chatId, userId) {
    return this.db.prepare(`
      SELECT chat_id, user_id, user_name, device_id, slot, slot_id,
             device_name, game_state, result, lines, round_id,
             last_event_trans_id, last_event_message_id,
             pending_command, pending_command_id, command_acked, updated_at
      FROM battle_players WHERE chat_id = ? AND user_id = ?
    `).get(String(chatId || ""), String(userId || "")) || null;
  }

  playerForDevice(chatId, deviceId) {
    return this.db.prepare(`
      SELECT chat_id, user_id, user_name, device_id, slot, slot_id,
             device_name, game_state, result, lines, round_id,
             last_event_trans_id, last_event_message_id,
             pending_command, pending_command_id, command_acked, updated_at
       FROM battle_players WHERE chat_id = ? AND device_id = ?
    `).get(String(chatId || ""), String(deviceId || "")) || null;
  }

  activateDeviceRoute(chatId, userId, deviceId, now = Date.now()) {
    const id = required(chatId, "chatId");
    const uid = required(userId, "userId");
    const did = required(deviceId, "deviceId");
    const result = this.db.prepare(`
      INSERT INTO battle_device_routes (device_id, chat_id, user_id, activated_at)
      SELECT device_id, chat_id, user_id, ?
      FROM battle_players
      WHERE chat_id = ? AND user_id = ? AND device_id = ?
      ON CONFLICT(device_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        user_id = excluded.user_id,
        activated_at = excluded.activated_at
    `).run(now, id, uid, did);
    if (Number(result.changes) !== 1) throw new Error("Cannot activate an unbound battle device");
    return this.activePlayerForDevice(did);
  }

  deviceRoute(deviceId) {
    return this.db.prepare(`
      SELECT device_id, chat_id, user_id, activated_at
      FROM battle_device_routes
      WHERE device_id = ?
    `).get(String(deviceId || "")) || null;
  }

  resetPlayerForRouteActivation(chatId, userId, now = Date.now()) {
    this.db.prepare(`
      UPDATE battle_players
      SET game_state = 'join', result = NULL, lines = 0, round_id = '',
          last_event_trans_id = '', last_event_message_id = '',
          pending_command = '', pending_command_id = '', command_acked = 0,
          updated_at = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(now, String(chatId || ""), String(userId || ""));
    return this.playerForUser(chatId, userId);
  }

  activePlayerForDevice(deviceId) {
    return this.db.prepare(`
      SELECT player.chat_id, player.user_id, player.user_name, player.device_id,
             player.slot, player.slot_id, player.device_name, player.game_state,
             player.result, player.lines, player.round_id,
             player.last_event_trans_id, player.last_event_message_id,
             player.pending_command, player.pending_command_id,
             player.command_acked, player.updated_at
      FROM battle_device_routes AS route
      JOIN battle_players AS player
        ON player.chat_id = route.chat_id
       AND player.user_id = route.user_id
       AND player.device_id = route.device_id
      WHERE route.device_id = ?
    `).get(String(deviceId || "")) || null;
  }

  removeOrphanedRoutes(chatId) {
    this.db.prepare(`
      DELETE FROM battle_device_routes
      WHERE chat_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM battle_players AS player
          WHERE player.chat_id = battle_device_routes.chat_id
            AND player.user_id = battle_device_routes.user_id
            AND player.device_id = battle_device_routes.device_id
        )
    `).run(String(chatId || ""));
  }

  updateState(chatId, userId, state, options = {}) {
    if (!VALID_STATES.has(state)) throw new Error(`Invalid battle state: ${state}`);
    const lines = Math.max(0, Math.floor(Number(options.lines || 0)));
    this.db.prepare(`
      UPDATE battle_players
      SET game_state = ?, result = ?, lines = ?, updated_at = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(
      state,
      options.result == null ? null : String(options.result),
      lines,
      Number(options.now || Date.now()),
      String(chatId || ""),
      String(userId || ""),
    );
    return this.playerForUser(chatId, userId);
  }

  setResult(chatId, userId, result, now = Date.now()) {
    this.db.prepare(`
      UPDATE battle_players
      SET game_state = 'finished', result = ?, updated_at = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(String(result), now, String(chatId), String(userId));
  }

  setRound(chatId, roundId, now = Date.now()) {
    this.db.prepare(`
      UPDATE battle_players
      SET round_id = ?, last_event_trans_id = '', last_event_message_id = '',
          pending_command = '', pending_command_id = '', command_acked = 0,
          updated_at = ?
      WHERE chat_id = ?
    `).run(String(roundId), now, String(chatId));
  }

  resetPlayerTransport(chatId, userId, transId = "", now = Date.now()) {
    this.db.prepare(`
      UPDATE battle_players
      SET round_id = ?, pending_command = '', pending_command_id = '', command_acked = 0,
          updated_at = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(String(transId), now, String(chatId), String(userId));
  }

  recordEvent(chatId, userId, transId, messageId, now = Date.now()) {
    const player = this.playerForUser(chatId, userId);
    if (!player) return false;
    if (player.last_event_trans_id === String(transId)) {
      const previousId = Number(player.last_event_message_id);
      const nextId = Number(messageId);
      if (Number.isFinite(previousId) && Number.isFinite(nextId) && nextId <= previousId) return false;
      if (player.last_event_message_id === String(messageId)) return false;
    }
    this.db.prepare(`
      UPDATE battle_players
      SET last_event_trans_id = ?, last_event_message_id = ?, updated_at = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(String(transId), String(messageId), now, String(chatId), String(userId));
    return true;
  }

  setPendingCommand(chatId, userId, command, commandId, now = Date.now()) {
    this.db.prepare(`
      UPDATE battle_players
      SET pending_command = ?, pending_command_id = ?, command_acked = 0, updated_at = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(String(command), String(commandId), now, String(chatId), String(userId));
    return this.playerForUser(chatId, userId);
  }

  ackCommand(chatId, userId, transId, commandId, now = Date.now()) {
    return Number(this.db.prepare(`
      UPDATE battle_players SET command_acked = 1, updated_at = ?
      WHERE chat_id = ? AND user_id = ? AND round_id = ? AND pending_command_id = ?
    `).run(now, String(chatId), String(userId), String(transId), String(commandId)).changes) > 0;
  }

  upsertGroupUser(chatId, profile, now = Date.now()) {
    const id = required(chatId, "chatId");
    const userId = required(profile?.userId, "userId");
    const userName = String(profile?.userName || "").trim();
    const avatarUrl = String(profile?.avatarUrl || "").trim();
    this.db.prepare(`
      INSERT INTO battle_group_users (
        chat_id, user_id, user_name, avatar_url, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        user_name = CASE
          WHEN excluded.user_name <> '' THEN excluded.user_name
          ELSE battle_group_users.user_name
        END,
        avatar_url = CASE
          WHEN excluded.avatar_url <> '' THEN excluded.avatar_url
          ELSE battle_group_users.avatar_url
        END,
        updated_at = excluded.updated_at
    `).run(id, userId, userName, avatarUrl, Number(now));
    return this.groupUser(id, userId);
  }

  groupUser(chatId, userId) {
    return this.db.prepare(`
      SELECT chat_id, user_id, user_name, avatar_url, updated_at
      FROM battle_group_users
      WHERE chat_id = ? AND user_id = ?
    `).get(String(chatId || ""), String(userId || "")) || null;
  }

  recordMatch(chatId, roundId, winner, loser, now = Date.now()) {
    const id = required(chatId, "chatId");
    const rid = required(roundId, "roundId");
    const winnerId = required(winner?.user_id, "winner.user_id");
    const loserId = required(loser?.user_id, "loser.user_id");
    if (winnerId === loserId) throw new Error("Battle match requires two different users");
    const [playerAId, playerBId] = [winnerId, loserId].sort();
    const playerALines = playerAId === winnerId ? winner.lines : loser.lines;
    const playerBLines = playerBId === winnerId ? winner.lines : loser.lines;
    const result = this.db.prepare(`
      INSERT INTO battle_matches (
        chat_id, round_id, player_a_id, player_b_id, winner_id, loser_id,
        player_a_lines, player_b_lines, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, round_id) DO NOTHING
    `).run(
      id,
      rid,
      playerAId,
      playerBId,
      winnerId,
      loserId,
      Math.max(0, Math.floor(Number(playerALines || 0))),
      Math.max(0, Math.floor(Number(playerBLines || 0))),
      Number(now),
    );
    return Number(result.changes) === 1;
  }

  leaderboard(chatId) {
    return this.db.prepare(`
      SELECT
        matches.player_a_id,
        matches.player_b_id,
        COALESCE(player_a.user_name, '') AS player_a_name,
        COALESCE(player_b.user_name, '') AS player_b_name,
        COALESCE(player_a.avatar_url, '') AS player_a_avatar,
        COALESCE(player_b.avatar_url, '') AS player_b_avatar,
        SUM(CASE WHEN matches.winner_id = matches.player_a_id THEN 1 ELSE 0 END) AS player_a_wins,
        SUM(CASE WHEN matches.winner_id = matches.player_b_id THEN 1 ELSE 0 END) AS player_b_wins,
        COUNT(*) AS games,
        MAX(matches.finished_at) AS last_played_at
      FROM battle_matches AS matches
      LEFT JOIN battle_group_users AS player_a
        ON player_a.chat_id = matches.chat_id
       AND player_a.user_id = matches.player_a_id
      LEFT JOIN battle_group_users AS player_b
        ON player_b.chat_id = matches.chat_id
       AND player_b.user_id = matches.player_b_id
      WHERE matches.chat_id = ?
      GROUP BY matches.player_a_id, matches.player_b_id
      ORDER BY games DESC, last_played_at DESC
    `).all(String(chatId || ""));
  }

  close() {
    this.db.close();
  }
}

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new TypeError(`${name} is required`);
  return result;
}
