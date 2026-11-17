import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BubbleBot, InlineKeyboard } from "@jeejio-bubble/bot/sdk";
import PixelMugS1 from "@jeejio-bubble/bot/devices/pixelmug-s1/ext";
import { BattleStore } from "./battle-store.js";
import { resolveRoundOutcome } from "./battle-rules.js";
import { parseBattleEvent, peerSnapshotMessage, resultCommandPayload } from "./battle-protocol.js";
const token = requiredEnv("BOT_TOKEN");
const mpsID = requiredEnv("STUDIO_MPS_ID");
const mpsVersion = requiredEnv("STUDIO_MPS_VERSION");
const webAppUrl = launchUrl(requiredEnv("STUDIO_WEBAPP_URL"));

const store = new BattleStore(
  process.env.BATTLE_DB_PATH || fileURLToPath(new URL("./data/battle.sqlite", import.meta.url)),
);
const battleDebug = process.env.BATTLE_DEBUG !== "false";
const pushInFlight = new Set();
const peerSnapshots = new Map();
const lastCommandPushAt = new Map();
const pendingPushTraces = new Map();
const COMMAND_RETRY_INTERVAL_MS = 2000;
const messages = {
  "zh-CN": {
    intro: "你好，我是方块掉落双人对战游戏智能体。我的主要功能是让两位玩家分别在自己的 PixelMug 上进行方块掉落对战，并记录胜负和排行榜。游戏需要两位玩家和我在同一个群聊中；开始之前，请先绑定两台 PixelMug。",
    bindButton: "查看并绑定对战设备",
    bindingConnected: "已关联",
    bindingDisconnected: "已取消关联",
    bindingNotice: "玩家 @{userName} {action} PixelMug。",
    bindingUpdated: "PixelMug 关联信息已更新。",
    bindingDeferred: "设备绑定已提交；对战资格会在打开 WebApp 时检查。",
    commands: "命令：/bindDevice、/battle",
    battleGroupRequired: "两位玩家和 Bot 必须在同一个群聊中，请到对战群里使用 /battle",
    battleUserUnknown: "无法识别发起命令的用户",
    battleButton: "打开我的对战手柄",
    battleEntry: "两位玩家的 PixelMug 已绑定并在线，可以开始对战。",
    battleStartFailed: "无法启动对战游戏：{error}",
    webAppGroupOnly: "只能从对战群中打开此 WebApp",
    spectatorNoDevice: "当前用户没有绑定本群的对战设备",
    statePlayerUnknown: "无法识别当前对战玩家",
    stateNotPlayer: "当前用户不在本场对战中",
    rankingGroupUnknown: "无法识别当前对战群",
    contextChatUnknown: "无法识别当前会话",
    playerGroupRequired: "两位玩家和 Bot 必须在同一个群聊中",
    webAppUserUnknown: "无法识别打开 WebApp 的用户",
    playerNotOwner: "当前用户不是两个已绑定设备的所属用户",
    playerFallback: "玩家",
    noDevices: "当前群还没有关联 PixelMug，请先使用 /bindDevice 关联两台设备",
    oneDevice: "当前群只有一个已关联的 PixelMug，还需要另一位玩家关联第二台设备",
    wrongDeviceCount: "当前群关联了 {count} 台 PixelMug，对战必须恰好使用两台设备",
    missingOwner: "设备绑定信息缺少所属用户",
    sameOwner: "两台设备属于同一位玩家，必须由两个不同玩家分别关联设备",
    sameDevice: "两个设备槽关联了同一台设备，必须关联两台不同设备",
    missingSlots: "设备槽 1 和设备槽 2 必须全部关联",
    offlineSlots: "设备槽 {slots} 的 PixelMug 当前离线，请连接设备后重试 /battle",
    unknownOnlineSlots: "无法确认设备槽 {slots} 的 PixelMug 是否在线，请稍后重试 /battle",
    bindGroupOnly: "双人对战的设备槽属于群聊。请先把两位玩家和 Bot 加入同一个群，然后在群里使用 /bindDevice。",
    bindRules: "# 🎮 欢迎来到方块下落游戏（双人对战版）\n\n游戏需要在同一个冒泡群组中进行，两位玩家分别关联自己的 **PixelMug**。\n\n## 🏆 游戏规则\n\n- 每位玩家在自己的 PixelMug 上进行游戏。\n- 两位玩家都进行到游戏结束，并按最终消除行数判定胜负；行数相同则为平局。\n- 如果一位玩家始终没有开始，另一位玩家结束时，未开始玩家按 0 行判负。\n\n## ✨ 让我们开始吧！",
    bindPrompt: "两位玩家请分别选择一个尚未占用的设备槽，并关联自己的 PixelMug。",
    commandBind: "绑定两位玩家的 PixelMugS1",
    commandBattle: "打开方块落下双人对战",
    unknownError: "未知错误",
    bindingRequired: "此应用需要绑定两台设备。请在群聊中使用 /bindDevice，分别绑定两位玩家的 PixelMug。",
  },
  "en-US": {
    intro: "Hello, I am the Block Drop Battle game agent. I let two players battle on their own PixelMugs and keep track of results and leaderboards. Both players and I need to be in the same group; before you start, please bind two PixelMugs.",
    bindButton: "Bind Battle PixelMugs",
    bindingConnected: "has bound",
    bindingDisconnected: "has unbound",
    bindingNotice: "Player @{userName} {action} a PixelMug.",
    bindingUpdated: "PixelMug bindings have been updated.",
    bindingDeferred: "The device binding was submitted. Battle eligibility will be checked when the WebApp opens.",
    commands: "Commands: /bindDevice, /battle",
    battleGroupRequired: "Both players and the Bot must be in the same group. Use /battle in the battle group.",
    battleUserUnknown: "Could not identify the player who requested the battle",
    battleButton: "Open my battle controller",
    battleEntry: "Both players' PixelMugs are bound and online. The battle is ready to start.",
    battleStartFailed: "Could not start the battle: {error}",
    webAppGroupOnly: "Open this WebApp from the battle group",
    spectatorNoDevice: "You do not have a battle device bound in this group",
    statePlayerUnknown: "Could not identify the current battle player",
    stateNotPlayer: "You are not a player in this battle",
    rankingGroupUnknown: "Could not identify the current battle group",
    contextChatUnknown: "Could not identify the current chat",
    playerGroupRequired: "Both players and the Bot must be in the same group",
    webAppUserUnknown: "Could not identify the user opening the WebApp",
    playerNotOwner: "You do not own either of the two bound battle devices",
    playerFallback: "Player",
    noDevices: "No PixelMug is bound in this group. Use /bindDevice to bind two devices.",
    oneDevice: "Only one PixelMug is bound in this group. Another player must bind the second device.",
    wrongDeviceCount: "This group has {count} bound PixelMugs; a battle requires exactly two.",
    missingOwner: "A device binding has no owner",
    sameOwner: "Both devices belong to the same player. Two different players must bind them.",
    sameDevice: "Both slots refer to the same device. Bind two different devices.",
    missingSlots: "Device slots 1 and 2 must both be bound",
    offlineSlots: "The PixelMug in slot {slots} is offline. Connect it and retry /battle.",
    unknownOnlineSlots: "The online status of the PixelMug in slot {slots} is unavailable. Retry /battle shortly.",
    bindGroupOnly: "Battle device slots belong to a group chat. Add the Bot and both players to the same group, then use /bindDevice there.",
    bindRules: "# 🎮 Welcome to Block Drop Battle\n\nTwo players in the same Bubble group each bind their own **PixelMug**.\n\n## 🏆 Rules\n\n- Each player plays on their own PixelMug.\n- The player who clears more lines wins; equal scores are a draw.\n- If one player never starts, they lose with zero lines when the other player finishes.\n\n## ✨ Get started",
    bindPrompt: "Each player should select an available device slot and bind their own PixelMug.",
    commandBind: "Bind both players' PixelMugS1 devices",
    commandBattle: "Open Block Drop Battle",
    unknownError: "Unknown error",
    bindingRequired: "This battle requires two bound devices. Use /bindDevice in the group so each player can bind a PixelMug.",
  },
};

// Two declarations create two required Bubble device slots.
const pixelMug1 = new PixelMugS1();
const pixelMug2 = new PixelMugS1();
pixelMug1.name = "Player 1 · PixelMugS1";
pixelMug2.name = "Player 2 · PixelMugS1";
const pixelMugs = [pixelMug1, pixelMug2];
const bot = new BubbleBot(token, {
  apiBaseUrl: process.env.BOT_API_BASE_URL,
  observeWebAppDeviceCalls: true,
  webAppDeviceAccess: "all",
  group_policy: "open",
});

bot.registerDevices(pixelMugs);
bot.on("error", async (ctx) => console.error("[block-drop-battle-bot]", ctx.error || ctx));
bot.on("device_call:response", async (ctx) => {
  const trace = pendingPushTraces.get(ctx.deviceCall?.traceId);
  if (trace) pendingPushTraces.delete(ctx.deviceCall?.traceId);
  battleLog("push.asyncResponse", {
    traceId: ctx.deviceCall?.traceId,
    command: trace?.command,
    roundId: trace?.roundId,
    elapsedMs: trace ? Date.now() - trace.startedAt : undefined,
    chatId: ctx.deviceCall?.chat?.id,
    slot: ctx.deviceCall?.slot,
    result: ctx.deviceCall?.result ?? ctx.deviceCall?.response?.tal?.result,
  });
});
bot.on("device_call:error", async (ctx) => {
  const trace = pendingPushTraces.get(ctx.deviceCall?.traceId);
  if (trace) pendingPushTraces.delete(ctx.deviceCall?.traceId);
  battleLog("push.asyncError", {
    traceId: ctx.deviceCall?.traceId,
    command: trace?.command,
    roundId: trace?.roundId,
    elapsedMs: trace ? Date.now() - trace.startedAt : undefined,
    chatId: ctx.deviceCall?.chat?.id,
    slot: ctx.deviceCall?.slot,
    method: ctx.deviceCall?.rpc?.method,
    code: ctx.deviceCall?.code ?? ctx.deviceCall?.error?.code,
    error: errorMessage(ctx.deviceCall?.error || ctx.error),
    details: ctx.deviceCall?.error?.details || ctx.deviceCall?.response?.update,
  });
});
bot.on("device_call:timeout", async (ctx) => {
  const trace = pendingPushTraces.get(ctx.deviceCall?.traceId);
  if (trace) pendingPushTraces.delete(ctx.deviceCall?.traceId);
  battleLog("push.asyncTimeout", {
    traceId: ctx.deviceCall?.traceId,
    command: trace?.command,
    roundId: trace?.roundId,
    elapsedMs: trace ? Date.now() - trace.startedAt : undefined,
    chatId: ctx.deviceCall?.chat?.id,
    slot: ctx.deviceCall?.slot,
    timeoutMillis: ctx.deviceCall?.timeoutMillis,
  });
});

bot.on("contact_added", async (ctx) => {
  await sendAddedIntro(ctx);
});

bot.on("joined_group", async (ctx) => {
  await sendAddedIntro(ctx, { mentionOnly: false });
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
      await sendBindingNotice(ctx, connectedPlayer, "bindingConnected", { public: true });
    } else if (disconnectedPlayer) {
      await sendBindingNotice(ctx, disconnectedPlayer, "bindingDisconnected", { public: true });
    } else {
      await ctx.sendText(messageFor(ctx, "bindingUpdated"));
    }
  } catch (error) {
    console.error("[block-drop-battle-bot] could not persist binding snapshot", error);
    await ctx.sendText(messageFor(ctx, "bindingDeferred"));
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
  if (command) await ctx.sendText(messageFor(ctx, "commands"));
});

async function sendBattleEntry(ctx) {
  const userId = userIdFromContext(ctx);
  try {
    if (!isGroupChat(ctx)) throw new Error(messageFor(ctx, "battleGroupRequired"));
    if (!userId) throw new Error(messageFor(ctx, "battleUserUnknown"));
    rememberContextUser(ctx);
    const { devices } = await syncBindingSnapshot(ctx, { validateBattle: true });
    validateOnlineDevices(devices, ctx);

    const keyboard = new InlineKeyboard().url(messageFor(ctx, "battleButton"), webAppUrl);
    await ctx.sendKeyboard(
      messageFor(ctx, "battleEntry"),
      keyboard,
      { mentionOnly: ctx.chat?.type === "group" ? true : undefined },
    );
  } catch (error) {
    await ctx.sendText(messageFor(ctx, "battleStartFailed", { error: errorMessage(error, ctx) }));
  }
}

bot.onWebAppRequest("battle.getAccess", async (ctx) => {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!isGroupChat(ctx) || !chatId || !userId) {
    throw webAppAccessError(messageFor(ctx, "webAppGroupOnly"));
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
      reason: canPlay ? "" : messageFor(ctx, "spectatorNoDevice"),
    };
  } catch (error) {
    const reason = errorMessage(error, ctx);
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
    throw webAppAccessError(messageFor(ctx, "statePlayerUnknown"));
  }
  const player = store.playerForUser(chatId, userId);
  if (!player) throw webAppAccessError(messageFor(ctx, "stateNotPlayer"));
  rememberContextUser(ctx);
  return {
    gameState: player.game_state,
    result: player.result || "",
    lines: player.lines,
  };
});

bot.onWebAppRequest("battle.getLeaderboard", async (ctx) => {
  const startedAt = Date.now();
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  const requestId = String(ctx.webAppData?.id || "");
  battleLog("webapp.leaderboard.request", { requestId, chatId, userId });
  if (!isGroupChat(ctx) || !chatId || !userId) {
    throw webAppAccessError(messageFor(ctx, "rankingGroupUnknown"));
  }
  rememberContextUser(ctx);
  const rows = leaderboardRows(store.leaderboard(chatId), userId);
  battleLog("webapp.leaderboard", { requestId, chatId, userId, rowCount: rows.length, durationMs: Date.now() - startedAt });
  return { groupName: String(ctx.chat?.name || ""), rows };
});

bot.onWebAppRequest("battle.getPersonalLeaderboard", async (ctx) => {
  const chatId = chatIdFromContext(ctx);
  const userId = userIdFromContext(ctx);
  if (!isGroupChat(ctx) || !chatId || !userId) {
    throw webAppAccessError(messageFor(ctx, "rankingGroupUnknown"));
  }
  rememberContextUser(ctx);
  const rows = personalLeaderboardRows(store.personalLeaderboard(chatId));
  battleLog("webapp.personalLeaderboard", { chatId, userId, rowCount: rows.length });
  return { groupName: String(ctx.chat?.name || ""), rows };
});

let eventChain = Promise.resolve();
bot.on("device_notify", async (ctx) => {
  const arrivedAt = Date.now();
  eventChain = eventChain
    .then(() => handleDeviceNotify(ctx, arrivedAt))
    .catch((error) => console.error("[block-drop-battle-bot] device event failed", error));
  await eventChain;
});

await bot.setCommands([
  {
    command: "bindDevice",
    description: messages["en-US"].commandBind,
    descTranslations: { "zh-CN": messages["zh-CN"].commandBind, en: messages["en-US"].commandBind },
  },
  {
    command: "battle",
    description: messages["en-US"].commandBattle,
    descTranslations: { "zh-CN": messages["zh-CN"].commandBattle, en: messages["en-US"].commandBattle },
  },
]);
await bot.start({ device: true });
console.log("mps-block-drop-battle bot is running.");
let studioRunId = "";
try { studioRunId = String(JSON.parse(process.env.PIXELMUG_STUDIO_DEBUG || "{}").runId || ""); } catch {}
battleLog("bot.started", { pid: process.pid, studioRunId });
console.log(`WebApp URL: ${webAppUrl}`);

async function syncBindingSnapshot(ctx, options = {}) {
  const chatId = chatIdFromContext(ctx);
  if (!chatId) throw new Error(messageFor(ctx, "contextChatUnknown"));
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
  if (options.validateBattle) validateBattleSnapshot(snapshot, ctx);
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
  if (!isGroupChat(ctx)) throw webAppAccessError(messageFor(ctx, "playerGroupRequired"));
  if (!chatId || !userId) throw webAppAccessError(messageFor(ctx, "webAppUserUnknown"));
  // Always authorize against the server-side group slot list. WebApp payloads
  // are client-controlled and cannot establish ownership or routing.
  const { players } = await syncBindingSnapshot(ctx, { validateBattle: true });
  const player = players.find((item) => item.user_id === userId);
  if (!player) throw webAppAccessError(messageFor(ctx, "playerNotOwner"));
  return { chatId, userId, player, players };
}

async function sendBindingNotice(ctx, player, actionKey, options = {}) {
  const userId = String(player.user_id || "");
  const currentUserName = userId === userIdFromContext(ctx) ? ctx.from?.name : "";
  const userName = String(player.user_name || currentUserName || messageFor(ctx, "playerFallback"));
  await ctx.sendText(messageFor(ctx, "bindingNotice", {
    userName,
    action: messageFor(ctx, actionKey),
  }), {
    at: userId ? [userId] : undefined,
    mentionOnly: ctx.chat?.type === "group" ? !options.public : undefined,
  });
}

function validateBattleSnapshot(players, ctx) {
  if (players.length === 0) throw new Error(messageFor(ctx, "noDevices"));
  if (players.length === 1) throw new Error(messageFor(ctx, "oneDevice"));
  if (players.length !== 2) throw new Error(messageFor(ctx, "wrongDeviceCount", { count: players.length }));
  if (players.some((item) => !item.userId)) throw new Error(messageFor(ctx, "missingOwner"));
  if (new Set(players.map((item) => item.userId)).size !== 2) throw new Error(messageFor(ctx, "sameOwner"));
  if (new Set(players.map((item) => item.deviceId)).size !== 2) throw new Error(messageFor(ctx, "sameDevice"));
  const slots = new Set(players.map((item) => Number(item.slot)));
  if (!slots.has(1) || !slots.has(2)) throw new Error(messageFor(ctx, "missingSlots"));
}

function validateOnlineDevices(devices, ctx) {
  const slotsFor = (status) => devices
    .filter((device) => device.online === status)
    .map((device) => Number(device.slot))
    .join(", ");
  const offlineSlots = slotsFor(false);
  if (offlineSlots) throw new Error(messageFor(ctx, "offlineSlots", { slots: offlineSlots }));
  const unknownSlots = slotsFor(undefined);
  if (unknownSlots) throw new Error(messageFor(ctx, "unknownOnlineSlots", { slots: unknownSlots }));
}

async function handleDeviceNotify(ctx, arrivedAt) {
  // Device-originated notifications identify the physical mug in ctx.from.id.
  const deviceId = String(ctx.from?.id || "");
  const events = pixelMug1.parseNotify(ctx.tal?.notify || []);
  if (events.length) battleLog("deviceNotify.received", { deviceId, queueWaitMs: Date.now() - arrivedAt, events });

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
      queueWaitMs: Date.now() - arrivedAt,
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
      if (acked) lastCommandPushAt.delete(`${deviceId}:${battleEvent.ackMessageId}`);
      battleLog("command.ack", { deviceId, acked, battleEvent });
      continue;
    }
    if (
      ["PLAYING", "SCORE", "GAME_OVER"].includes(battleEvent.type)
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
      if (battleEvent.type === "PLAYING") {
        const current = store.playerForDevice(player.chat_id, deviceId);
        if (current?.game_state === "playing" && !current.result) syncOpponentSnapshot(current);
      }
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
    return false;
  }
  const transId = shortId();
  store.setRound(chatId, transId);
  for (const player of players) store.updateState(chatId, player.user_id, "go");
  const roundPlayers = store.players(chatId);
  battleLog("round.go", { chatId, transId, deviceIds: roundPlayers.map((item) => item.device_id) });
  schedulePushes(roundPlayers.map((player) => issueCommand(player, "GO")));
  return true;
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
  const outcome = resolveRoundOutcome(players, endedUserId);
  battleLog("round.finishCheck", { chatId, endedUserId, outcome, players: playerStates(players) });
  if (outcome.status === "waiting") return;

  if (outcome.autoFinishUserId) {
    const autoFinished = store.updateState(chatId, outcome.autoFinishUserId, "finished", { lines: 0 });
    recordPersonalBest(autoFinished, 0);
  }

  if (outcome.status === "draw") {
    for (const userId of outcome.playerIds) store.setResult(chatId, userId, "draw");
    const drawnPlayers = outcome.playerIds.map((userId) => store.playerForUser(chatId, userId));
    battleLog("round.draw", {
      chatId,
      roundId: drawnPlayers[0]?.round_id || drawnPlayers[1]?.round_id || "",
      lines: drawnPlayers[0]?.lines || 0,
      userIds: outcome.playerIds,
    });
    schedulePushes(drawnPlayers.map((player) => issueCommand(player, "DRAW")), 20);
    return;
  }

  store.setResult(chatId, outcome.winnerId, "win");
  store.setResult(chatId, outcome.loserId, "lose");
  const winner = store.playerForUser(chatId, outcome.winnerId);
  const loser = store.playerForUser(chatId, outcome.loserId);
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
  const opponent = store.players(player.chat_id).find((item) => item.user_id !== player.user_id);
  const payload = resultCommandPayload(command, player.lines, opponent?.lines || 0);
  const updated = store.setPendingCommand(player.chat_id, player.user_id, payload, commandId);
  return pendingCommandJob(updated);
}

function syncOpponentSnapshot(source) {
  const opponent = store.players(source.chat_id).find((item) => item.user_id !== source.user_id);
  if (!opponent || !source.round_id || opponent.round_id !== source.round_id || opponent.result) return;
  if (!["go", "playing", "finished"].includes(opponent.game_state)) return;
  const key = `${source.chat_id}:${source.round_id}:${opponent.device_id}`;
  const snapshot = `${source.lines}:${source.game_state === "finished" ? "F" : "P"}`;
  const previous = peerSnapshots.get(key);
  const now = Date.now();
  if (previous?.snapshot === snapshot && now - previous.sentAt < 10000) return;
  peerSnapshots.set(key, { snapshot, sentAt: now });
  if (peerSnapshots.size > 1024) peerSnapshots.delete(peerSnapshots.keys().next().value);
  const message = peerSnapshotMessage(source.round_id, shortId(), source.lines, source.game_state === "finished");
  battleLog("peer.snapshot", {
    chatId: source.chat_id, fromDeviceId: source.device_id, toDeviceId: opponent.device_id,
    lines: source.lines, finished: source.game_state === "finished",
  });
  void pushToPlayer(opponent, message);
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
  if (job) schedulePushes([job], 0, COMMAND_RETRY_INTERVAL_MS);
}

function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function schedulePushes(jobs, waitMs = 0, minIntervalMs = 0) {
  for (const job of jobs.filter(Boolean)) {
    const key = `${job.player.device_id}:${job.player.pending_command_id}`;
    if (pushInFlight.has(key)) continue;
    const now = Date.now();
    if (minIntervalMs && now - (lastCommandPushAt.get(key) || 0) < minIntervalMs) continue;
    lastCommandPushAt.set(key, now);
    if (lastCommandPushAt.size > 1024) lastCommandPushAt.delete(lastCommandPushAt.keys().next().value);
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
  const startedAt = Date.now();
  const [, roundId, commandId, command] = message.split("|");
  battleLog("push.request", {
    message,
    command,
    commandId,
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
      submissionMs: Date.now() - startedAt,
      deviceId: player.device_id,
      slot: player.slot,
    });
    if (task.traceId) {
      pendingPushTraces.set(task.traceId, { command, roundId, startedAt });
      if (pendingPushTraces.size > 1024) pendingPushTraces.delete(pendingPushTraces.keys().next().value);
    }
  } catch (error) {
    battleLog("push.failed", {
      message,
      submissionMs: Date.now() - startedAt,
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

function sendAddedIntro(ctx, options = {}) {
  return ctx.sendBindDevice({
    content: messageFor(ctx, "intro"),
    actionButtonTitle: messageFor(ctx, "bindButton"),
    ...options,
  });
}

function localeFromContext(ctx) {
  const source = String(ctx?.from?.language || ctx?.chat?.language || process.env.APP_LOCALE || "").toLowerCase();
  return source.startsWith("zh") ? "zh-CN" : "en-US";
}

function messageFor(ctx, key, params = {}) {
  const locale = localeFromContext(ctx);
  const template = messages[locale]?.[key] || messages["en-US"][key] || key;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.split(`{${name}}`).join(String(value)),
    template,
  );
}

async function sendBindDevice(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.sendText(messageFor(ctx, "bindGroupOnly"));
    return;
  }
  await ctx.sendMarkdown(messageFor(ctx, "bindRules"), { mentionOnly: true });
  await ctx.sendBindDevice({
    content: messageFor(ctx, "bindPrompt"),
    actionButtonTitle: messageFor(ctx, "bindButton"),
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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function errorMessage(error, ctx) {
  const message = error instanceof Error ? error.message : String(error || messageFor(ctx, "unknownError"));
  if (/requires device binding|\/attachdevice/i.test(message)) {
    return messageFor(ctx, "bindingRequired");
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

function personalLeaderboardRows(rows) {
  return rows.map((row, index) => ({
    rank: index + 1,
    userId: row.user_id,
    name: row.user_name || shortUserName(row.user_id),
    avatar: row.avatar_url || "",
    bestLines: Number(row.best_lines || 0),
    updatedAt: Number(row.updated_at || 0),
  }));
}

function recordPersonalBest(player, lines) {
  if (!player) return;
  try {
    store.upsertGroupUser(player.chat_id, {
      userId: player.user_id,
      userName: player.user_name,
    });
    const updated = store.recordPersonalBest(player.chat_id, player.user_id, lines);
    battleLog("leaderboard.personalBest", {
      chatId: player.chat_id,
      userId: player.user_id,
      lines: Math.max(0, Math.floor(Number(lines || 0))),
      updated,
    });
  } catch (error) {
    battleLog("leaderboard.personalBestFailed", {
      chatId: player.chat_id,
      userId: player.user_id,
      error: errorMessage(error),
    });
  }
}

function shortUserName(userId) {
  const value = String(userId || "player");
  return value.length > 12 ? `${value.slice(0, 9)}…` : value;
}

function battleLog(event, data = {}) {
  if (!battleDebug) return;
  console.log(`[block-drop-battle][${new Date().toISOString()}] ${event}`, data);
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
    if (!await startRoundIfReady(player.chat_id)) syncReadyDisplay(player.chat_id);
    return;
  }
  if (type === "PLAYING" || type === "SCORE") {
    if (player.result) return;
    if (!["go", "playing"].includes(player.game_state)) return;
    const nextLines = Math.max(player.lines, lines);
    const started = player.game_state !== "playing";
    const changed = started || nextLines > player.lines;
    const updated = store.updateState(player.chat_id, player.user_id, "playing", { lines: nextLines });
    if (changed) syncOpponentSnapshot(updated);
    if (started) {
      const opponent = store.players(player.chat_id).find((item) => item.user_id !== player.user_id);
      if (["playing", "finished"].includes(opponent?.game_state)) syncOpponentSnapshot(opponent);
    }
    return;
  }
  if (player.game_state === "finished") return;
  if (!["go", "playing"].includes(player.game_state)) return;
  const finalLines = Math.max(player.lines, lines);
  const finishedPlayer = store.updateState(player.chat_id, player.user_id, "finished", { lines: finalLines });
  recordPersonalBest(finishedPlayer, finalLines);
  syncOpponentSnapshot(finishedPlayer);
  await finishRound(player.chat_id, player.user_id);
}

