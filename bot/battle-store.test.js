import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BattleStore } from "./battle-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "block-drop-battle-"));
  const store = new BattleStore(join(root, "battle.sqlite"));
  return {
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const players = [
  { userId: "user-a", deviceId: "device-a", slot: 1, slotId: "slot-a" },
  { userId: "user-b", deviceId: "device-b", slot: 2, slotId: "slot-b" },
];

test("stores exactly two distinct users and devices", () => {
  const item = fixture();
  try {
    item.store.replaceBindings("group-1", players, 100);
    assert.deepEqual(item.store.players("group-1").map((row) => row.game_state), ["join", "join"]);
    assert.equal(item.store.playerForDevice("group-1", "device-b").user_id, "user-b");
  } finally {
    item.close();
  }
});

test("rejects two devices belonging to the same user", () => {
  const item = fixture();
  try {
    assert.throws(() => item.store.replaceBindings("group-1", [
      players[0],
      { ...players[1], userId: "user-a" },
    ]), /different users/);
  } finally {
    item.close();
  }
});

test("tracks the battle state and result", () => {
  const item = fixture();
  try {
    item.store.replaceBindings("group-1", players);
    item.store.updateState("group-1", "user-a", "ready");
    item.store.updateState("group-1", "user-a", "playing");
    item.store.updateState("group-1", "user-a", "finished", { lines: 12 });
    item.store.setResult("group-1", "user-a", "lose");
    const player = item.store.playerForUser("group-1", "user-a");
    assert.equal(player.game_state, "finished");
    assert.equal(player.result, "lose");
    assert.equal(player.lines, 12);
  } finally {
    item.close();
  }
});

test("aggregates bindings arriving in separate binding events", () => {
  const item = fixture();
  try {
    item.store.upsertBinding("group-1", players[0]);
    assert.equal(item.store.players("group-1").length, 1);
    item.store.upsertBinding("group-1", players[1]);
    assert.deepEqual(
      item.store.players("group-1").map((row) => [row.user_id, row.device_id, row.slot]),
      [["user-a", "device-a", 1], ["user-b", "device-b", 2]],
    );
  } finally {
    item.close();
  }
});

test("rejects two users selecting the same battle slot", () => {
  const item = fixture();
  try {
    item.store.upsertBinding("group-1", players[0]);
    assert.throws(() => item.store.upsertBinding("group-1", { ...players[1], slot: 1 }), /UNIQUE constraint/);
    assert.equal(item.store.players("group-1").length, 1);
  } finally {
    item.close();
  }
});

test("replaces the persisted records from the shared slot snapshot", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", [players[0]]);
    assert.deepEqual(item.store.players("group-1").map((row) => row.device_id), ["device-a"]);
    item.store.replaceSnapshot("group-1", players);
    assert.deepEqual(item.store.players("group-1").map((row) => row.device_id), ["device-a", "device-b"]);
    item.store.replaceSnapshot("group-1", []);
    assert.equal(item.store.players("group-1").length, 0);
  } finally {
    item.close();
  }
});

test("refreshing an unchanged shared snapshot preserves ready state", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", players);
    item.store.updateState("group-1", "user-a", "ready");
    item.store.replaceSnapshot("group-1", players);
    assert.equal(item.store.playerForUser("group-1", "user-a").game_state, "ready");
    assert.equal(item.store.playerForUser("group-1", "user-b").game_state, "join");
  } finally {
    item.close();
  }
});

test("routes one physical device independently in multiple groups", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", players, 100);
    item.store.replaceSnapshot("group-2", [
      { userId: "user-c", deviceId: "device-a", slot: 1, slotId: "slot-c" },
      { userId: "user-d", deviceId: "device-d", slot: 2, slotId: "slot-d" },
    ], 200);

    assert.deepEqual(item.store.players("group-1").map((row) => row.device_id), ["device-a", "device-b"]);
    assert.equal(item.store.playerForDevice("group-1", "device-a").user_id, "user-a");
    assert.equal(item.store.playerForDevice("group-2", "device-a").user_id, "user-c");
    assert.equal(item.store.playerForDevice("missing-group", "device-a"), null);
  } finally {
    item.close();
  }
});

test("switches the active device route when WebApp starts from another group", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", players, 100);
    item.store.replaceSnapshot("group-2", [
      { userId: "user-c", deviceId: "device-a", slot: 1, slotId: "slot-c" },
      { userId: "user-d", deviceId: "device-d", slot: 2, slotId: "slot-d" },
    ], 200);

    item.store.activateDeviceRoute("group-1", "user-a", "device-a", 300);
    assert.equal(item.store.activePlayerForDevice("device-a").chat_id, "group-1");

    item.store.activateDeviceRoute("group-2", "user-c", "device-a", 400);
    assert.equal(item.store.activePlayerForDevice("device-a").chat_id, "group-2");
    assert.equal(item.store.activePlayerForDevice("device-a").user_id, "user-c");
  } finally {
    item.close();
  }
});

test("resets stale player state when activating a device in another group", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", players);
    item.store.replaceSnapshot("group-2", [
      { userId: "user-c", deviceId: "device-a", slot: 1, slotId: "slot-c" },
      { userId: "user-d", deviceId: "device-d", slot: 2, slotId: "slot-d" },
    ]);
    item.store.updateState("group-2", "user-c", "playing", { lines: 8 });
    item.store.setRound("group-2", "stale-round");
    item.store.setPendingCommand("group-2", "user-c", "GO", "stale-command");
    item.store.activateDeviceRoute("group-1", "user-a", "device-a");

    const previousRoute = item.store.deviceRoute("device-a");
    assert.equal(previousRoute.chat_id, "group-1");
    item.store.activateDeviceRoute("group-2", "user-c", "device-a");
    const player = item.store.resetPlayerForRouteActivation("group-2", "user-c");

    assert.equal(player.game_state, "join");
    assert.equal(player.lines, 0);
    assert.equal(player.round_id, "");
    assert.equal(player.pending_command, "");
    assert.equal(player.last_event_message_id, "");
  } finally {
    item.close();
  }
});

test("clears an active route when the group binding no longer contains the device", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", players);
    item.store.activateDeviceRoute("group-1", "user-a", "device-a");
    item.store.replaceSnapshot("group-1", [players[1]]);
    assert.equal(item.store.activePlayerForDevice("device-a"), null);
  } finally {
    item.close();
  }
});

test("deduplicates transport messages and acknowledges commands per battle transaction", () => {
  const item = fixture();
  try {
    item.store.replaceBindings("group-1", players);
    item.store.setRound("group-1", "round-1");
    assert.equal(item.store.recordEvent("group-1", "user-a", "round-1", "1"), true);
    assert.equal(item.store.recordEvent("group-1", "user-a", "round-1", "1"), false);
    assert.equal(item.store.recordEvent("group-1", "user-a", "round-1", "2"), true);
    assert.equal(item.store.recordEvent("group-1", "user-a", "round-1", "1"), false);

    const pending = item.store.setPendingCommand("group-1", "user-a", "GO", "command-1");
    assert.equal(pending.command_acked, 0);
    assert.equal(item.store.ackCommand("group-1", "user-a", "wrong-round", "command-1"), false);
    assert.equal(item.store.ackCommand("group-1", "user-a", "round-1", "command-1"), true);
    assert.equal(item.store.playerForUser("group-1", "user-a").command_acked, 1);
  } finally {
    item.close();
  }
});

test("stores group profiles without erasing a known avatar", () => {
  const item = fixture();
  try {
    item.store.upsertGroupUser("group-1", {
      userId: "user-a",
      userName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    }, 100);
    item.store.upsertGroupUser("group-1", { userId: "user-a", userName: "Alice 2" }, 200);
    assert.deepEqual({ ...item.store.groupUser("group-1", "user-a") }, {
      chat_id: "group-1",
      user_id: "user-a",
      user_name: "Alice 2",
      avatar_url: "https://example.com/alice.png",
      updated_at: 200,
    });
  } finally {
    item.close();
  }
});

test("aggregates match wins once per round and isolates groups", () => {
  const item = fixture();
  try {
    item.store.upsertGroupUser("group-1", { userId: "user-a", userName: "Alice" });
    item.store.upsertGroupUser("group-1", { userId: "user-b", userName: "Bob" });
    const alice = { user_id: "user-a", lines: 8 };
    const bob = { user_id: "user-b", lines: 5 };

    assert.equal(item.store.recordMatch("group-1", "round-1", alice, bob, 100), true);
    assert.equal(item.store.recordMatch("group-1", "round-1", alice, bob, 100), false);
    assert.equal(item.store.recordMatch("group-1", "round-2", bob, alice, 200), true);
    assert.equal(item.store.recordMatch("group-1", "round-3", alice, bob, 300), true);
    assert.equal(item.store.recordMatch("group-2", "round-1", bob, alice, 400), true);

    assert.deepEqual(item.store.leaderboard("group-1").map((row) => ({ ...row })), [{
      player_a_id: "user-a",
      player_b_id: "user-b",
      player_a_name: "Alice",
      player_b_name: "Bob",
      player_a_avatar: "",
      player_b_avatar: "",
      player_a_wins: 2,
      player_b_wins: 1,
      games: 3,
      last_played_at: 300,
    }]);
    assert.equal(item.store.leaderboard("group-2")[0].games, 1);
    assert.equal(item.store.leaderboard("missing-group").length, 0);
  } finally {
    item.close();
  }
});

test("leaderboard history survives current binding removal", () => {
  const item = fixture();
  try {
    item.store.replaceSnapshot("group-1", players);
    item.store.recordMatch(
      "group-1",
      "round-1",
      { user_id: "user-a", lines: 4 },
      { user_id: "user-b", lines: 2 },
    );
    item.store.replaceSnapshot("group-1", []);
    assert.equal(item.store.players("group-1").length, 0);
    assert.equal(item.store.leaderboard("group-1")[0].player_a_wins, 1);
  } finally {
    item.close();
  }
});

test("personal best only increases and is isolated and ranked by group", () => {
  const item = fixture();
  try {
    item.store.upsertGroupUser("group-1", {
      userId: "user-a",
      userName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    });
    item.store.upsertGroupUser("group-1", { userId: "user-b", userName: "Bob" });

    assert.equal(item.store.recordPersonalBest("group-1", "user-a", 8, 100), true);
    assert.equal(item.store.recordPersonalBest("group-1", "user-a", 5, 200), false);
    assert.equal(item.store.recordPersonalBest("group-1", "user-a", 8, 300), false);
    assert.equal(item.store.recordPersonalBest("group-1", "user-a", 12, 400), true);
    assert.equal(item.store.recordPersonalBest("group-1", "user-b", 15, 500), true);
    assert.equal(item.store.recordPersonalBest("group-2", "user-a", 3, 600), true);

    assert.deepEqual(item.store.personalLeaderboard("group-1").map((row) => ({ ...row })), [
      {
        user_id: "user-b",
        user_name: "Bob",
        avatar_url: "",
        best_lines: 15,
        updated_at: 500,
      },
      {
        user_id: "user-a",
        user_name: "Alice",
        avatar_url: "https://example.com/alice.png",
        best_lines: 12,
        updated_at: 400,
      },
    ]);
    assert.equal(item.store.personalLeaderboard("group-2")[0].best_lines, 3);
    assert.equal(item.store.personalLeaderboard("missing-group").length, 0);
  } finally {
    item.close();
  }
});
