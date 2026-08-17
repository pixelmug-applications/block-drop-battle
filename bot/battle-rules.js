export function resolveRoundOutcome(players, endedUserId) {
  const items = Array.isArray(players) ? players : [];
  const ended = items.find((player) => player.user_id === String(endedUserId || ""));
  const opponent = items.find((player) => player.user_id !== String(endedUserId || ""));
  if (!ended || !opponent || ended.result || opponent.result || ended.game_state !== "finished") {
    return { status: "waiting", reason: "round is not ready to settle" };
  }

  if (opponent.game_state === "playing") {
    return { status: "waiting", reason: "opponent is still playing" };
  }

  if (opponent.game_state === "go") {
    return {
      status: "win",
      winnerId: ended.user_id,
      loserId: opponent.user_id,
      autoFinishUserId: opponent.user_id,
    };
  }

  if (opponent.game_state !== "finished") {
    return { status: "waiting", reason: `opponent state is ${opponent.game_state}` };
  }

  const endedLines = normalizedLines(ended.lines);
  const opponentLines = normalizedLines(opponent.lines);
  if (endedLines === opponentLines) {
    return { status: "draw", playerIds: [ended.user_id, opponent.user_id] };
  }
  return endedLines > opponentLines
    ? { status: "win", winnerId: ended.user_id, loserId: opponent.user_id }
    : { status: "win", winnerId: opponent.user_id, loserId: ended.user_id };
}

function normalizedLines(value) {
  return Math.max(0, Math.floor(Number(value || 0)));
}
