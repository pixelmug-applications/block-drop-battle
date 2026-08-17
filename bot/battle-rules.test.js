import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoundOutcome } from "./battle-rules.js";

const player = (userId, gameState, lines = 0) => ({
  user_id: userId,
  game_state: gameState,
  lines,
  result: null,
});

test("waits after the first player ends while the opponent is still playing", () => {
  assert.deepEqual(
    resolveRoundOutcome([player("a", "finished", 4), player("b", "playing", 2)], "a"),
    { status: "waiting", reason: "opponent is still playing" },
  );
});

test("compares cleared lines only after both players finish", () => {
  assert.deepEqual(
    resolveRoundOutcome([player("a", "finished", 4), player("b", "finished", 7)], "b"),
    { status: "win", winnerId: "b", loserId: "a" },
  );
});

test("returns a draw when both players clear the same number of lines", () => {
  assert.deepEqual(
    resolveRoundOutcome([player("a", "finished", 5), player("b", "finished", 5)], "b"),
    { status: "draw", playerIds: ["b", "a"] },
  );
});

test("an unstarted GO player loses with zero lines even when the finisher has zero", () => {
  assert.deepEqual(
    resolveRoundOutcome([player("a", "finished", 0), player("b", "go", 0)], "a"),
    { status: "win", winnerId: "a", loserId: "b", autoFinishUserId: "b" },
  );
});
