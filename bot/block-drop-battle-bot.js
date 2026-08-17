import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BubbleBot, InlineKeyboard } from "../../jeejio-bubble/sdk/BubbleSDK.js";
import PixelMugS1 from "../../jeejio-bubble/devices/ext/PixelMugS1_1.0.ext.js";
import { BattleStore } from "./battle-store.js";
import { apiBaseUrl, token, mpsID, mpsVersion } from "./config.dev.js";

const port = Number(process.env.WEBAPP_PORT || 8820);
const host = process.env.WEBAPP_HOST || process.env.HOST || "127.0.0.1";
const baseUrl = process.env.WEBAPP_URL || `http://${host}:${port}/index.html`;
const webAppUrl = launchUrl(baseUrl);
const shouldServeStatic = !process.env.WEBAPP_URL;
const store = new BattleStore(process.env.BATTLE_DB_PATH || resolve("bot/data/battle.sqlite"));
const battleDebug = process.env.BATTLE_DEBUG !== "false";
const pushInFlight = new Set();

if (!token) throw new Error("Missing BUBBLE_BOT_TOKEN");
if (!mpsID || !mpsVersion) throw new Error("Missing MPS_ID or MPS_VERSION");

// Two declarations create two required Bubble device slots.
const pixelMug1 = new PixelMugS1();
const pixelMug2 = new PixelMugS1();
pixelMug1.name = "玩家 1 · PixelMugS1";
pixelMug2.name = "玩家 2 · PixelMugS1";
const pixelMugs = [pixelMug1, pixelMug2];
const bot = new BubbleBot(token, {
  apiBaseUrl,
  debug: process.env.DEBUG !== "false",
  observeWebAppDeviceCalls: true,
  webAppDeviceAccess: "any",
  group_policy: "open",
});

bot.registerDevices(pixelMugs);
bot.on("error", async (ctx) => console.error("[block-drop-battle-bot]", ctx.error || ctx));
bot.on("device_call:response", async (ctx) => {
  battleLog("push.asyncResponse", {
    traceId: ctx.deviceCall?.traceId,
    chatId: ctx.deviceCall?.chat?.id,
    slot: ctx.deviceCall?.slot,
    result: ctx.deviceCall?.result ?? ctx.deviceCall?.response?.tal?.result,
  });
});
bot.on("device_call:timeout", async (ctx) => {
  battleLog("push.asyncTimeout", {
    traceId: ctx.deviceCall?.traceId,
    chatId: ctx.deviceCall?.chat?.id,
    slot: ctx.deviceCall?.slot,
    timeoutMillis: ctx.deviceCall?.timeoutMillis,
  });
});

bot.on("message:bind_device", async (ctx) => {
  try {
    const chatId = chatIdFromContext(ctx);
    const previous = store.players(chatId);
    const { players } = await syncBindingSnapshot(ctx, {
      validateBattle: false,
      boundDevices: ctx.message?.attachedDevices,
    });
    battleLog("binding.snapshot", { chatId: chatIdFromContext(ctx), players: playerStates(players) });
    rememberContextUser(ctx);
    const userId = userIdFromContext(ctx);
    const connectedPlayer = players.find((player) => player.user_id === userId);
    const disconnectedPlayer = previous.find((player) => player.user_id === userId);
    if (connectedPlayer) {
      await sendBindingNotice(ctx, connectedPlayer, "已经关联", { public: true });
    } else if (disconnectedPlayer) {
      await sendBindingNotice(ctx, disconnectedPlayer, "已取消关联", { public: true });
    } else {
      await ctx.sendText("PixelMug 关联信息已更新。");
    }
  } catch (error) {
    console.error("[block-drop-battle-bot] could not persist binding snapshot", error);
    await ctx.sendText("设备绑定已提交；对战资格会在打开 WebApp 时检查。");
  }
});

bot.on("message", async (ctx) => {
  const command = extractCommand(ctx.message?.content || ctx.message?.text || "");
  if (command === "/bindDevice") {
    await sendBindDevice(ctx);
    return;
  }
  if (command === "/battle" || command === "/start") {
    await sendBattleEntry(ctx);
    return;
  }
  if (command) await ctx.sendText("命令：/bindDevice、/battle");
});

async function sendBattleEntry(ctx) {
  const userId = userIdFromContext(ctx);
  try {
    if (!isGroupChat(ctx)) throw new Error("两位玩家和 Bot 必须在同一个群聊中，请到对战群里使用 /battle");
    if (!userId) throw new Error("无法识别发起命令的用户");
    rememberContextUser(ctx);

    const keyboard = new InlineKeyboard().url("打开我的对战手柄", webAppUrl);
    await ctx.sendKeyboard(
      "检查设备关联，启动对战游戏。\n\n**注意：必须两个不同玩家绑定不同设备才能进入游戏。**",
      keyboard,
      { mentionOnly: ctx.chat?.type === "group" ? true : undefined },
    );
  } catch (error) {
    await ctx.sendText(`无法启动对战游戏：${errorMessage(error)}`);
  }
}

bot.onWebAppRequest("battle.getAccess", async (ctx) => {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!isGroupChat(ctx) || !chatId || !userId) {
    throw webAppAccessError("只能从对战群中打开此 WebApp");
  }

  rememberContextUser(ctx);
  try {
    const { players } = await syncBindingSnapshot(ctx, { validateBattle: true });
    const player = players.find((item) => item.user_id === userId);
    const canPlay = Boolean(player);
    battleLog("webapp.access", { chatId, userId, canPlay, players: playerStates(players) });
    return {
      role: canPlay ? "player" : "spectator",
      canPlay,
      reason: canPlay ? "" : "当前用户没有绑定本群的对战设备",
    };
  } catch (error) {
    const reason = errorMessage(error);
    battleLog("webapp.access", { chatId, userId, canPlay: false, reason });
    return { role: "spectator", canPlay: false, reason };
  }
});

bot.onWebAppRequest("battle.resolveDevice", async (ctx) => {
  const { chatId, userId, player, players } = await authorizedBattlePlayer(ctx);
  battleLog("webapp.resolveDevice", {
    chatId,
    clickUserId: userId,
    players: playerStates(players),
  });

  return {
    userId,
    deviceId: player.device_id,
    slot: player.slot,
    slotId: player.slot_id,
    gameState: player.game_state,
    mps: { id: mpsID, version: mpsVersion },
  };
});

bot.onWebAppRequest("battle.activateDevice", async (ctx) => {
  const { chatId, userId, player } = await authorizedBattlePlayer(ctx);
  const previousRoute = store.deviceRoute(player.device_id);
  const routeChanged = !previousRoute
    || previousRoute.chat_id !== chatId
    || previousRoute.user_id !== userId;
  store.activateDeviceRoute(chatId, userId, player.device_id);
  if (routeChanged) store.resetPlayerForRouteActivation(chatId, userId);
  battleLog("deviceRoute.activated", {
    chatId,
    userId,
    deviceId: player.device_id,
    slot: player.slot,
    routeChanged,
    previousChatId: previousRoute?.chat_id || "",
  });

  return {
    activated: true,
    deviceId: player.device_id,
    chatId,
  };
});

bot.onWebAppRequest("battle.getState", async (ctx) => {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!isGroupChat(ctx) || !chatId || !userId) {
    throw webAppAccessError("无法识别当前对战玩家");
  }
  const player = store.playerForUser(chatId, userId);
  if (!player) throw webAppAccessError("当前用户不在本场对战中");
  rememberContextUser(ctx);
  return {
    gameState: player.game_state,
    result: player.result || "",
    lines: player.lines,
  };
});

bot.onWebAppRequest("battle.getLeaderboard", async (ctx) => {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!isGroupChat(ctx) || !chatId || !userId) {
    throw webAppAccessError("无法识别当前对战群");
  }
  rememberContextUser(ctx);
  const rows = leaderboardRows(store.leaderboard(chatId), userId);
  battleLog("webapp.leaderboard", { chatId, userId, rowCount: rows.length });
  return { groupName: String(ctx.chat?.name || ""), rows };
});

let eventChain = Promise.resolve();
bot.on("device_notify", async (ctx) => {
  eventChain = eventChain
    .then(() => handleDeviceNotify(ctx))
    .catch((error) => console.error("[block-drop-battle-bot] device event failed", error));
  await eventChain;
});

await bot.setCommands([
  { command: "bindDevice", description: "绑定两位玩家的 PixelMugS1" },
  { command: "battle", description: "打开方块落下双人对战" },
]);
if (shouldServeStatic) await startStaticServer();
await bot.start({ device: true });
console.log("mps-block-drop-battle bot is running.");
console.log(`WebApp URL: ${webAppUrl}`);

async function syncBindingSnapshot(ctx, options = {}) {
  const chatId = chatIdFromContext(ctx);
  if (!chatId) throw new Error("无法识别当前会话");
  // A bind-device event carries the post-change slot snapshot in
  // message.attachedDevices. Other callers reload the authoritative group list.
  const boundDevices = Array.isArray(options.boundDevices)
    ? options.boundDevices
    : await bot.getBoundDevices(ctx, { contactId: chatId });
  const devices = boundDevices
    .filter(isPixelMug)
    .sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0));
  const snapshot = devices.map((device) => ({
    userId: String(device.ownerId || ""),
    userName: String(device.ownerName || device.raw?.device?.ownerName || device.raw?.device?.userName || ""),
    deviceId: deviceKey(device),
    slot: Number(device.slot),
    slotId: String(device.slotId || ""),
    deviceName: String(device.name || "PixelMugS1"),
  }));
  if (options.validateBattle) validateBattleSnapshot(snapshot);
  const players = store.replaceSnapshot(chatId, snapshot);
  for (const player of snapshot) {
    store.upsertGroupUser(chatId, {
      userId: player.userId,
      userName: player.userName,
    });
  }
  return { devices, players };
}

async function authorizedBattlePlayer(ctx) {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!isGroupChat(ctx)) throw webAppAccessError("两位玩家和 Bot 必须在同一个群聊中");
  if (!chatId || !userId) throw webAppAccessError("无法识别打开 WebApp 的用户");
  // Always authorize against the server-side group slot list. WebApp payloads
  // are client-controlled and cannot establish ownership or routing.
  const { players } = await syncBindingSnapshot(ctx, { validateBattle: true });
  const player = players.find((item) => item.user_id === userId);
  if (!player) throw webAppAccessError("当前用户不是两个已绑定设备的所属用户");
  return { chatId, userId, player, players };
}

async function sendBindingNotice(ctx, player, action, options = {}) {
  const userId = String(player.user_id || "");
  const currentUserName = userId === userIdFromContext(ctx) ? ctx.from?.name : "";
  const userName = String(player.user_name || currentUserName || "玩家");
  await ctx.sendText(`玩家 @${userName} ${action} PixelMug。`, {
    at: userId ? [userId] : undefined,
    mentionOnly: ctx.chat?.type === "group" ? !options.public : undefined,
  });
}

function validateBattleSnapshot(players) {
  if (players.length === 0) throw new Error("当前群还没有关联 PixelMug，请先使用 /bindDevice 关联两台设备");
  if (players.length === 1) throw new Error("当前群只有一个已关联的 PixelMug，还需要另一位玩家关联第二台设备");
  if (players.length !== 2) throw new Error(`当前群关联了 ${players.length} 台 PixelMug，对战必须恰好使用两台设备`);
  if (players.some((item) => !item.userId)) throw new Error("设备绑定信息缺少所属用户");
  if (new Set(players.map((item) => item.userId)).size !== 2) throw new Error("两台设备属于同一位玩家，必须由两个不同玩家分别关联设备");
  if (new Set(players.map((item) => item.deviceId)).size !== 2) throw new Error("两个设备槽关联了同一台设备，必须关联两台不同设备");
  const slots = new Set(players.map((item) => Number(item.slot)));
  if (!slots.has(1) || !slots.has(2)) throw new Error("设备槽 1 和设备槽 2 必须全部关联");
}

async function handleDeviceNotify(ctx) {
  // Device-originated notifications identify the physical mug in ctx.from.id.
  const deviceId = String(ctx.from?.id || "");
  const events = pixelMug1.parseNotify(ctx.tal?.notify || []);
  battleLog("deviceNotify.received", { deviceId, events });

  for (const event of events) {
    if (event.name !== "mpyVmEvent") continue;
    const battleEvent = parseBattleEvent(event.params?.value);
    if (!battleEvent) continue;
    const player = deviceId ? store.activePlayerForDevice(deviceId) : null;
    if (!player) {
      battleLog("battleEvent.unroutableDevice", { deviceId, battleEvent });
      continue;
    }
    battleLog("deviceNotify.activeRoute", {
      deviceId,
      routedChatId: player.chat_id,
      routedUserId: player.user_id,
    });
    battleLog("battleEvent.received", {
      deviceId,
      chatId: player.chat_id,
      userId: player.user_id,
      previousState: player.game_state,
      battleEvent,
    });
    if (battleEvent.type === "ACK") {
      const acked = store.ackCommand(
        player.chat_id,
        player.user_id,
        battleEvent.transId,
        battleEvent.ackMessageId,
      );
      battleLog("command.ack", { deviceId, acked, battleEvent });
      continue;
    }
    if (
      ["PLAYING", "GAME_OVER"].includes(battleEvent.type)
      && player.round_id
      && battleEvent.transId !== player.round_id
    ) {
      battleLog("battleEvent.staleTransaction", {
        deviceId,
        expected: player.round_id,
        received: battleEvent.transId,
      });
      await redeliverPendingCommand(player);
      continue;
    }
    const isNew = store.recordEvent(
      player.chat_id,
      player.user_id,
      battleEvent.transId,
      battleEvent.messageId,
    );
    if (isNew) {
      await applyBattleState(player, battleEvent);
    } else {
      battleLog("battleEvent.duplicate", { deviceId, battleEvent });
    }
    await redeliverPendingCommand(store.playerForDevice(player.chat_id, deviceId));
    battleLog("battleEvent.stored", {
      chatId: player.chat_id,
      players: playerStates(store.players(player.chat_id)),
    });
  }
}

async function startRoundIfReady(chatId) {
  const players = store.players(chatId);
  battleLog("round.readyCheck", { chatId, players: playerStates(players) });
  if (players.length !== 2 || !players.every((item) => item.game_state === "ready")) {
    battleLog("round.waiting", {
      chatId,
      reason: players.length !== 2 ? `player count is ${players.length}` : "not every player is ready",
    });
    return;
  }
  const transId = shortId();
  store.setRound(chatId, transId);
  for (const player of players) store.updateState(chatId, player.user_id, "go");
  const roundPlayers = store.players(chatId);
  battleLog("round.go", { chatId, transId, deviceIds: roundPlayers.map((item) => item.device_id) });
  schedulePushes(roundPlayers.map((player) => issueCommand(player, "GO")), 20);
}

function syncReadyDisplay(chatId) {
  const players = store.players(chatId);
  const readyCount = players.filter((player) => player.game_state === "ready").length;
  if (readyCount < 1) return;
  const command = readyCount >= 2 ? "P2_READY" : "P1_READY";
  battleLog("round.readyDisplay", {
    chatId,
    command,
    readyCount,
    deviceIds: players.map((player) => player.device_id),
  });
  // Lobby display updates are idempotent snapshots. Keep them outside the
  // transactional command slot so the following GO command cannot overwrite one.
  for (const player of players) {
    const message = `BDB2|${player.round_id}|${shortId()}|${command}`;
    // The GO transition must not wait for two device RPC round trips. GO also
    // carries the authoritative two-ready display state on the MPY side.
    void pushToPlayer(player, message);
  }
}

async function finishRound(chatId, endedUserId) {
  const players = store.players(chatId);
  const ended = players.find((item) => item.user_id === endedUserId);
  const opponent = players.find((item) => item.user_id !== endedUserId);
  if (!ended || !opponent || ended.result || opponent.result) return;

  let winner;
  let loser;
  if (opponent.game_state === "playing") {
    winner = opponent;
    loser = ended;
  } else if (["join", "ready", "go"].includes(opponent.game_state)) {
    winner = ended;
    loser = opponent;
  } else if (opponent.game_state === "finished") {
    winner = ended.lines >= opponent.lines ? ended : opponent;
    loser = winner.user_id === ended.user_id ? opponent : ended;
  } else {
    return;
  }

  store.setResult(chatId, winner.user_id, "win");
  store.setResult(chatId, loser.user_id, "lose");
  try {
    store.upsertGroupUser(chatId, { userId: winner.user_id, userName: winner.user_name });
    store.upsertGroupUser(chatId, { userId: loser.user_id, userName: loser.user_name });
    const recorded = store.recordMatch(chatId, winner.round_id || loser.round_id, winner, loser);
    battleLog("leaderboard.matchRecorded", {
      chatId,
      roundId: winner.round_id || loser.round_id,
      winnerId: winner.user_id,
      loserId: loser.user_id,
      recorded,
    });
  } catch (error) {
    // Leaderboard persistence is additive and must never block the existing
    // result delivery path.
    battleLog("leaderboard.matchRecordFailed", { chatId, error: errorMessage(error) });
  }
  schedulePushes([
    issueCommand(store.playerForUser(chatId, winner.user_id), "WIN"),
    issueCommand(store.playerForUser(chatId, loser.user_id), "LOSE"),
  ], 20);
}

function issueCommand(player, command) {
  const commandId = shortId();
  const updated = store.setPendingCommand(player.chat_id, player.user_id, command, commandId);
  return pendingCommandJob(updated);
}

function pendingCommandJob(player) {
  if (!player || !player.pending_command || !player.pending_command_id || player.command_acked) return null;
  return {
    player,
    message: `BDB2|${player.round_id}|${player.pending_command_id}|${player.pending_command}`,
  };
}

async function redeliverPendingCommand(player) {
  const job = pendingCommandJob(player);
  if (job) schedulePushes([job]);
}

function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function schedulePushes(jobs, waitMs = 0) {
  for (const job of jobs.filter(Boolean)) {
    const key = `${job.player.device_id}:${job.player.pending_command_id}`;
    if (pushInFlight.has(key)) continue;
    pushInFlight.add(key);
    void delay(waitMs)
      .then(() => pushToPlayer(job.player, job.message))
      .catch((error) => battleLog("push.failedUnexpectedly", { error: errorMessage(error) }))
      .finally(() => pushInFlight.delete(key));
  }
}

async function pushToPlayer(player, message) {
  const device = pixelMugs[Number(player.slot) - 1];
  if (!device) throw new Error(`Unknown device slot ${player.slot}`);
  battleLog("push.request", {
    message,
    chatId: player.chat_id,
    userId: player.user_id,
    deviceId: player.device_id,
    slot: player.slot,
  });
  try {
    const task = await bot.callDeviceAsync(
      { id: player.chat_id, type: "group" },
      device,
      device.rpc.pushMessage({ message }),
      // The binding belongs to the shared group. The slot, not a private-user
      // target, selects the exact physical device in that group.
      { slot: Number(player.slot) },
    );
    battleLog("push.asyncSent", {
      message,
      traceId: task.traceId,
      deviceId: player.device_id,
      slot: player.slot,
    });
  } catch (error) {
    battleLog("push.failed", {
      message,
      deviceId: player.device_id,
      slot: player.slot,
      error: errorMessage(error),
      details: error?.details || error?.response,
    });
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function sendBindDevice(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.sendText("双人对战的设备槽属于群聊。请先把两位玩家和 Bot 加入同一个群，然后在群里使用 /bindDevice。");
    return;
  }
  await ctx.sendMarkdown([
    "# 🎮 欢迎来到方块下落游戏（双人对战版）",
    "",
    "游戏需要在同一个冒泡群组中进行，两位玩家分别关联自己的 **PixelMug**。",
    "",
    "## 🏆 游戏规则",
    "",
    "- 每位玩家在自己的 PixelMug 上进行游戏。",
    "- 先结束游戏的玩家判为输，对手获胜。",
    "- 为防止作弊，如果一位玩家在对战中始终没有开始，另一位玩家结束游戏时，已开始游戏的玩家判为赢。",
    "",
    "## ✨ 让我们开始吧！",
  ].join("\n"), { mentionOnly: true });
  await ctx.sendBindDevice({
    content: "两位玩家请分别选择一个尚未占用的设备槽，并关联自己的 PixelMug。",
    actionButtonTitle: "查看并绑定对战设备",
    mentionOnly: true,
  });
}

function isGroupChat(ctx) {
  return ctx.chat?.type === "group";
}

function isPixelMug(device) {
  return device.talId === "PixelMugS1" || device.deviceTalId === "PixelMugS1" || (device.compatible || []).includes("PixelMugS1");
}

function deviceKey(device) {
  return String(device?.deviceId || device?.raw?.device?.id || "");
}

function chatIdFromContext(ctx) {
  return String(ctx.chat?.id || ctx.me?.id || ctx.to?.id || "");
}

function userIdFromContext(ctx) {
  return String(ctx.from?.id || "");
}

function extractCommand(value) {
  const match = String(value || "").trim().match(/\/[a-zA-Z0-9_-]+(?:@[a-zA-Z0-9_-]+)?/);
  return match ? match[0].split("@")[0] : "";
}

function launchUrl(value) {
  const url = new URL(value);
  url.searchParams.set("mps_id", mpsID);
  url.searchParams.set("mps_version", mpsVersion);
  return url.toString();
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  if (/requires device binding|\/attachdevice/i.test(message)) {
    return "此应用需要绑定设备。请发送“/attachdevice”，并按照提示绑定您的设备。";
  }
  return message;
}

function webAppAccessError(message) {
  const error = new Error(message);
  error.code = 403;
  return error;
}

function playerStates(players) {
  return (players || []).map((player) => ({
    userId: player.user_id,
    deviceId: player.device_id,
    slot: player.slot,
    state: player.game_state,
    result: player.result,
    lines: player.lines,
    transId: player.round_id,
    pendingCommand: player.pending_command,
    pendingCommandId: player.pending_command_id,
    commandAcked: Boolean(player.command_acked),
  }));
}

function rememberContextUser(ctx) {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!chatId || !userId || String(ctx.from?.type || "user") !== "user") return null;
  return store.upsertGroupUser(chatId, {
    userId,
    userName: String(ctx.from?.name || ""),
    avatarUrl: safeAvatarUrl(ctx.from?.avatar),
  });
}

function safeAvatarUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function leaderboardRows(rows, viewerId) {
  return rows.map((row) => {
    let left = {
      userId: row.player_a_id,
      name: row.player_a_name || shortUserName(row.player_a_id),
      avatar: row.player_a_avatar || "",
      wins: Number(row.player_a_wins || 0),
    };
    let right = {
      userId: row.player_b_id,
      name: row.player_b_name || shortUserName(row.player_b_id),
      avatar: row.player_b_avatar || "",
      wins: Number(row.player_b_wins || 0),
    };
    if (
      (right.userId === viewerId && left.userId !== viewerId)
      || (left.userId !== viewerId && right.userId !== viewerId && right.wins > left.wins)
    ) {
      [left, right] = [right, left];
    }
    return {
      left,
      right,
      games: Number(row.games || 0),
      lastPlayedAt: Number(row.last_played_at || 0),
    };
  });
}

function shortUserName(userId) {
  const value = String(userId || "player");
  return value.length > 12 ? `${value.slice(0, 9)}…` : value;
}

function battleLog(event, data = {}) {
  if (!battleDebug) return;
  console.log(`[block-drop-battle][${new Date().toISOString()}] ${event}`, data);
}

function startStaticServer() {
  const root = fileURLToPath(new URL("../webapp/dist", import.meta.url));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const path = normalize(join(root, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
      if (relative(root, path).startsWith("..")) return reply(res, 403, "Forbidden");
      if (!(await stat(path)).isFile()) return reply(res, 404, "Not found");
      res.writeHead(200, { "content-type": contentType(path), "cache-control": "no-store" });
      createReadStream(path).pipe(res);
    } catch (error) {
      reply(res, 404, String(error?.code || "").includes("ENOENT") ? "Run npm run build first." : "Not found");
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => { server.off("error", reject); resolvePromise(server); });
  });
}

async function applyBattleState(player, event) {
  const { type, lines, transId } = event;
  if (type === "JOIN") {
    if (player.game_state !== "playing") {
      store.resetPlayerTransport(player.chat_id, player.user_id, transId);
      store.updateState(player.chat_id, player.user_id, "join");
    }
    return;
  }
  if (type === "READY") {
    if (player.game_state === "go") return;
    if (!["join", "ready", "finished"].includes(player.game_state)) return;
    if (player.game_state === "finished") {
      store.resetPlayerTransport(player.chat_id, player.user_id, transId);
    }
    store.updateState(player.chat_id, player.user_id, "ready");
    syncReadyDisplay(player.chat_id);
    await startRoundIfReady(player.chat_id);
    return;
  }
  if (type === "PLAYING") {
    if (player.result) return;
    if (!["go", "playing"].includes(player.game_state)) return;
    store.updateState(player.chat_id, player.user_id, "playing");
    return;
  }
  if (player.game_state === "finished" && player.result) return;
  if (!["go", "playing"].includes(player.game_state)) return;
  store.updateState(player.chat_id, player.user_id, "finished", { lines });
  await finishRound(player.chat_id, player.user_id);
}

function parseBattleEvent(raw) {
  const parts = String(raw || "").split("|");
  if (parts[0] !== "BDB2" || parts.length < 4) return null;
  if (!parts[1] || !parts[2]) return null;
  const type = String(parts[3] || "").toUpperCase();
  if (!["JOIN", "READY", "PLAYING", "GAME_OVER", "ACK"].includes(type)) return null;
  return {
    transId: String(parts[1] || ""),
    messageId: String(parts[2] || ""),
    type,
    lines: Math.max(0, Math.floor(Number(parts[4] || 0))),
    ackMessageId: type === "ACK" ? String(parts[4] || "") : "",
  };
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function contentType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" })[extname(path)] || "application/octet-stream";
}
