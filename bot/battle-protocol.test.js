import assert from "node:assert/strict";
import test from "node:test";
import { parseBattleEvent, peerSnapshotMessage, resultCommandPayload } from "./battle-protocol.js";

test("parses a fresh line-clear event and rejects malformed scores", () => {
  assert.deepEqual(parseBattleEvent("BDB2|round-a|17|SCORE|4|1|12345"), {
    transId: "round-a", messageId: "17", type: "SCORE", lines: 4,
    ackMessageId: "", reportAttempt: 1, deviceTickMs: 12345,
  });
  assert.equal(parseBattleEvent("BDB2|round-a|18|SCORE|invalid"), null);
  assert.equal(parseBattleEvent("BDB2|round-a|18|SCORE|-2"), null);
});

test("peer snapshot distinguishes a live score from a frozen score", () => {
  assert.equal(peerSnapshotMessage("round-a", "id-1", 7, false), "BDB2|round-a|id-1|PEER|7|P");
  assert.equal(peerSnapshotMessage("round-a", "id-2", 7, true), "BDB2|round-a|id-2|PEER|7|F");
});

test("final result carries scores in the recipient's own-opponent order", () => {
  assert.equal(resultCommandPayload("WIN", 5, 3), "WIN|5|3");
  assert.equal(resultCommandPayload("LOSE", 3, 5), "LOSE|3|5");
  assert.equal(resultCommandPayload("DRAW", 4, 4), "DRAW|4|4");
  assert.equal(resultCommandPayload("GO", 0, 0), "GO");
});
