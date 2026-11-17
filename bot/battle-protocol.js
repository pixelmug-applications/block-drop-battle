const RESULT_COMMANDS = new Set(["WIN", "LOSE", "DRAW"]);

export function parseBattleEvent(raw) {
  const parts = String(raw || "").split("|");
  if (parts[0] !== "BDB2" || parts.length < 5 || !parts[1] || !parts[2]) return null;
  const type = String(parts[3] || "").toUpperCase();
  if (!["JOIN", "READY", "PLAYING", "SCORE", "GAME_OVER", "ACK"].includes(type)) return null;
  const lines = type === "ACK" ? 0 : Number(parts[4]);
  if (type !== "ACK" && (!Number.isSafeInteger(lines) || lines < 0)) return null;
  if (type === "ACK" && !parts[4]) return null;
  return {
    transId: parts[1],
    messageId: parts[2],
    type,
    lines,
    ackMessageId: type === "ACK" ? parts[4] : "",
    reportAttempt: type === "ACK" ? 0 : Math.max(0, Math.floor(Number(parts[5] || 0))),
    deviceTickMs: type === "ACK" ? 0 : Math.max(0, Math.floor(Number(parts[6] || 0))),
  };
}

export function peerSnapshotMessage(roundId, commandId, lines, finished) {
  return `BDB2|${roundId}|${commandId}|PEER|${Math.max(0, Math.floor(lines))}|${finished ? "F" : "P"}`;
}

export function resultCommandPayload(command, ownLines, opponentLines) {
  if (!RESULT_COMMANDS.has(command)) return command;
  const own = Math.max(0, Math.floor(ownLines));
  const opponent = Math.max(0, Math.floor(opponentLines));
  return `${command}|${own}|${opponent}`;
}
