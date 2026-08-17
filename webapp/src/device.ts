import { computed, reactive } from 'vue';
import { BubbleWebApp } from '../../../jeejio-bubble/sdk/WebApp.js';
import { BleAppClient } from '../../../jeejio-bubble/sdk/BleAppClient.js';
import { t } from './i18n';

export type DeviceInfo = {
  name?: string;
  talId?: string;
  deviceTalId?: string;
  slot?: string | number;
  slotId?: string;
  deviceId?: string;
  ownerId?: string;
  online?: boolean;
  raw?: unknown;
};

type DeviceEventItem = {
  method?: string;
  name?: string;
  params?: { value?: unknown };
};

type DeviceEventPayload = {
  payload?: {
    device?: DeviceInfo;
    events?: DeviceEventItem[];
  };
};

export type BlockDropCommand = 'JOIN' | 'START' | 'LEFT' | 'RIGHT' | 'DOWN' | 'ROTATE' | 'DROP' | 'RESTART' | 'SOUND';
export type LaunchPhase = 'idle' | 'requesting' | 'preparing' | 'switching' | 'ready' | 'failed';
export type BattleAccessRole = 'checking' | 'player' | 'spectator';
export type LeaderboardPlayer = {
  userId: string;
  name: string;
  avatar: string;
  wins: number;
};
export type LeaderboardRow = {
  left: LeaderboardPlayer;
  right: LeaderboardPlayer;
  games: number;
  lastPlayedAt: number;
};
export type PersonalLeaderboardRow = {
  rank: number;
  userId: string;
  name: string;
  avatar: string;
  bestLines: number;
  updatedAt: number;
};

const state = reactive({
  connection: 'idle',
  message: '',
  launchPhase: 'idle' as LaunchPhase,
  lines: 0,
  gameState: 'join',
  soundEnabled: true,
});
const leaderboard = reactive({
  groupName: '',
  rows: [] as LeaderboardRow[],
  loading: false,
  error: '',
  loadedAt: 0,
});
const personalLeaderboard = reactive({
  groupName: '',
  rows: [] as PersonalLeaderboardRow[],
  loading: false,
  error: '',
  loadedAt: 0,
});
const access = reactive({
  role: 'checking' as BattleAccessRole,
  reason: '',
});
const hasBridge = () => Boolean((globalThis as { JeeWeb?: unknown }).JeeWeb);
const webApp = new BubbleWebApp({ debug: import.meta.env.DEV, timeoutMillis: 20000 });
let client: BleAppClient | null = null;
let device: DeviceInfo | null = null;
let stateSyncInFlight = false;
let stateSyncGeneration = 0;
let leaderboardGeneration = 0;
let personalLeaderboardGeneration = 0;
let battleResolution: {
  userId: string;
  deviceId: string;
  slot: number;
  slotId: string;
  gameState: string;
  mps: { id: string; version: string };
} | null = null;
let mpsEventsBound = false;
let lastInstallErrorCode = '';
let pendingLaunch: {
  deviceKey: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
const lastMpsEventByDevice = new Map<string, string>();
const lastMpsErrorByDevice = new Map<string, string>();

const MPS_OPEN_TIMEOUT_MS = 45000;
const READY_EVENTS = new Set(['MPS_IS_RUNNING']);
const FAILED_EVENTS = new Set(['INSTALL_FAIL', 'RUNNING_FAIL']);
const TERMINAL_GAME_STATES = new Set(['win', 'lose', 'draw']);

function protocolClient() {
  if (!client) {
    client = new BleAppClient(webApp.ble, {
      appId: 'BlockDropBattle',
      appVersion: '1.0.0',
      timeoutMillis: 9000,
      connectTimeoutMillis: 20000,
      readyGraceMillis: 8000,
      retries: 1,
      heartbeatMillis: -1,
    } as Record<string, unknown>);
    client.on('connectionState', (event) => {
      state.connection = String(event?.connection || 'unknown');
      state.message = String(event?.message || event?.lastError || '');
    });
    client.on('data', (event) => applyMessage(event?.message));
  }
  return client;
}

export function useBlockDropDevice() {
  const ready = computed(() => state.connection === 'ready' || !hasBridge());
  const connecting = computed(() => state.connection === 'connecting');
  const canControl = computed(() => access.role === 'player');

  async function openOnDevice() {
    state.launchPhase = 'requesting';
    state.message = t('status.findingDevice');
    try {
      if (!(await resolveBattleAccess())) {
        device = null;
        state.connection = 'idle';
        state.launchPhase = 'ready';
        state.message = t('status.spectator');
        return false;
      }
      device = await loadDevice();
      if (!device) throw new Error(t('status.deviceMissing'));
      await openMpsApp(device);
      await activateDeviceRoute();
      state.launchPhase = 'ready';
      state.message = t('status.launchReady');
      return true;

    } catch (error) {
      state.launchPhase = 'failed';
      state.message = errorMessage(error);
      throw error;
    }
  }

  async function connectDevice() {
    if (!canControl.value || !device) return;
    if (!hasBridge()) {
      state.connection = 'ready';
      state.message = t('status.mockConnected');
      return;
    }

    state.connection = 'connecting';
    state.message = t('status.connectingBle');
    try {
      await protocolClient().ensureConnected(device, {
        connectingMessage: 'Connecting BLE...',
        connectTimeoutMillis: 20000,
        readyGraceMillis: 8000,
        sendTimeoutMillis: 9000,
      });
      state.connection = 'ready';
      state.message = t('status.bleConnected');
      await syncState();
    } catch (error) {
      state.connection = 'failed';
      state.message = t('status.bleConnectFailed', { error: errorMessage(error) });
    }
  }

  async function reconnect() {
    if (!canControl.value || !device || !hasBridge() || connecting.value) return;
    state.connection = 'connecting';
    state.message = 'Connecting BLE...';
    try {
      await protocolClient().reconnect({
        connectingMessage: 'Connecting BLE...',
        connectTimeoutMillis: 20000,
        readyGraceMillis: 8000,
        sendTimeoutMillis: 9000,
      });
      state.connection = 'ready';
      state.message = 'BLE connected.';
      await syncState();
    } catch (error) {
      state.connection = 'failed';
      state.message = errorMessage(error);
    }
  }

  async function send(command: BlockDropCommand) {
    if (!canControl.value || !device || !ready.value) return false;
    if (!hasBridge()) {
      if (command === 'RESTART') state.lines = 0;
      if (command === 'SOUND') state.soundEnabled = !state.soundEnabled;
      return true;
    }
    if (command === 'JOIN' || command === 'START' || command === 'SOUND') {
      const response = await protocolClient().send(device, {
        method: command,
        id: `block_drop_battle_${command.toLowerCase()}_${Date.now()}`,
      }, { priority: 0, timeoutMillis: 2500 });
      applyMessage(responsePayload(response));
      return true;
    }
    await protocolClient().sendRealtime(command, {}, {
      device,
      ttlMillis: 260,
      writeType: 'withoutResponse',
      timeoutMillis: 600,
    });
    return true;
  }

  async function syncState() {
    if (!canControl.value || !device || !hasBridge()) return;
    const response = await protocolClient().send(device, {
      method: 'blockDropBattleGetState',
      id: `block_drop_battle_state_${Date.now()}`,
    }, {
      priority: 1,
      timeoutMillis: 2500,
      // A snapshot has its own request id and may safely bypass a reliable
      // command that was frozen at the head of the queue while iOS slept.
      serialize: false,
    });
    applyMessage(responsePayload(response));
  }

  async function refreshState(force = false) {
    if (!canControl.value || !hasBridge()) return false;
    // A WebView can freeze both the request and its timeout while the phone is
    // asleep. Foreground refreshes may replace that stale in-flight operation.
    if (stateSyncInFlight && !force) return false;
    const generation = ++stateSyncGeneration;
    stateSyncInFlight = true;
    try {
      // Bot state is independent of the foreground BLE connection. This is
      // essential when a suspended phone wakes after the round has ended.
      const tasks: Promise<unknown>[] = [syncBattleResult()];
      if (device && ready.value) tasks.push(syncState());
      const results = await Promise.allSettled(tasks);
      return results.some((result) => result.status === 'fulfilled');
    } finally {
      if (generation === stateSyncGeneration) {
        stateSyncInFlight = false;
      }
    }
  }

  async function loadLeaderboard(force = false) {
    if (!hasBridge() || (leaderboard.loading && !force)) return false;
    const generation = ++leaderboardGeneration;
    leaderboard.loading = true;
    leaderboard.error = '';
    try {
      const requestClient = webApp as BubbleWebApp & {
        request: (type: string, payload?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
      };
      const reply = await requestClient.request('battle.getLeaderboard') as any;
      const result = reply?.result || reply || {};
      leaderboard.groupName = String(result.groupName || '');
      leaderboard.rows = Array.isArray(result.rows)
        ? result.rows.map(normalizeLeaderboardRow).filter(Boolean) as LeaderboardRow[]
        : [];
      leaderboard.loadedAt = Date.now();
      return true;
    } catch (error) {
      leaderboard.error = errorMessage(error);
      return false;
    } finally {
      if (generation === leaderboardGeneration) leaderboard.loading = false;
    }
  }

  async function loadPersonalLeaderboard(force = false) {
    if (!hasBridge() || (personalLeaderboard.loading && !force)) return false;
    const generation = ++personalLeaderboardGeneration;
    personalLeaderboard.loading = true;
    personalLeaderboard.error = '';
    try {
      const requestClient = webApp as BubbleWebApp & {
        request: (type: string, payload?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
      };
      const reply = await requestClient.request('battle.getPersonalLeaderboard') as any;
      const result = reply?.result || reply || {};
      personalLeaderboard.groupName = String(result.groupName || '');
      personalLeaderboard.rows = Array.isArray(result.rows)
        ? result.rows.map(normalizePersonalLeaderboardRow).filter(Boolean) as PersonalLeaderboardRow[]
        : [];
      personalLeaderboard.loadedAt = Date.now();
      return true;
    } catch (error) {
      personalLeaderboard.error = errorMessage(error);
      return false;
    } finally {
      if (generation === personalLeaderboardGeneration) personalLeaderboard.loading = false;
    }
  }

  return {
    state,
    access,
    leaderboard,
    personalLeaderboard,
    ready,
    connecting,
    canControl,
    openOnDevice,
    connectDevice,
    reconnect,
    send,
    refreshState,
    loadLeaderboard,
    loadPersonalLeaderboard,
  };
}

async function resolveBattleAccess() {
  if (!hasBridge()) {
    access.role = 'player';
    access.reason = '';
    return true;
  }
  const requestClient = webApp as BubbleWebApp & {
    request: (type: string, payload?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  };
  const reply = await requestClient.request('battle.getAccess') as any;
  const result = reply?.result || reply || {};
  const canPlay = result.canPlay === true || result.role === 'player';
  access.role = canPlay ? 'player' : 'spectator';
  access.reason = String(result.reason || '');
  return canPlay;
}

async function openMpsApp(target: DeviceInfo) {
  const config = launchConfig();
  if (!config.id || !config.version) {
    throw new Error(t('status.missingConfig'));
  }

  state.launchPhase = 'requesting';
  state.message = t('status.launching');
  const key = deviceKey(target);
  lastMpsEventByDevice.delete(key);
  lastMpsErrorByDevice.delete(key);
  if (!hasBridge()) {
    state.launchPhase = 'ready';
    return;
  }

  bindMpsEvents();
  lastInstallErrorCode = '';
  await webApp.subscribeDeviceEvents(target);
  const ready = waitForMpsRunning(target);

  let response: unknown;
  try {
    response = await webApp.callDevice(target, {
      method: 'talMpyExecOneScript',
      params: { id: config.id, version: config.version },
    });
  } catch (error) {
    clearPendingLaunch();
    throw error;
  }

  const code = mpyExecReturnCode(response);
  if (code === 264) {
    clearPendingLaunch();
    state.launchPhase = 'ready';
    return;
  }
  if (code === 263 || code === 265) {
    state.launchPhase = 'switching';
    state.message = t('status.switching');
  } else if (code === 260 || code === 261 || code === 262) {
    state.launchPhase = 'preparing';
    state.message = t('status.preparing');
  } else {
    clearPendingLaunch();
    state.launchPhase = 'failed';
    throw new Error(t('status.openFailed', { code: Number.isFinite(code) ? code : 'unknown' }));
  }

  try {
    await ready;
    state.launchPhase = 'ready';
  } catch (error) {
    state.launchPhase = 'failed';
    throw error;
  }
}

function bindMpsEvents() {
  if (mpsEventsBound) return;
  webApp.onDeviceEvent(handleDeviceEvent);
  mpsEventsBound = true;
}

function waitForMpsRunning(target: DeviceInfo) {
  const key = deviceKey(target);
  const lastEvent = lastMpsEventByDevice.get(key);
  if (lastEvent && READY_EVENTS.has(lastEvent)) return Promise.resolve();
  if (lastEvent && FAILED_EVENTS.has(lastEvent)) {
    return Promise.reject(launchErrorForFailedEvent(lastEvent, key));
  }

  clearPendingLaunch();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingLaunch?.deviceKey === key) pendingLaunch = null;
      reject(new Error(t('status.launchTimeout')));
    }, MPS_OPEN_TIMEOUT_MS);
    pendingLaunch = { deviceKey: key, resolve, reject, timer };
  });
}

function handleDeviceEvent(raw: unknown) {
  const event = raw as DeviceEventPayload;
  const sourceDevice = event.payload?.device;
  const key = sourceDevice ? deviceKey(sourceDevice) : '';
  const items = event.payload?.events || [];
  const batchError = items
    .filter((item) => (item.method || item.name) === 'mpyVmError')
    .map((item) => parseInstallErrorCode(String(item.params?.value || '')))
    .find(Boolean);
  if (batchError) {
    lastInstallErrorCode = batchError;
    if (key) lastMpsErrorByDevice.set(key, batchError);
  }

  for (const item of items) {
    const name = item.method || item.name;
    const value = String(item.params?.value || '');

    if (name === 'mpyVmError') {
      const code = parseInstallErrorCode(value) || 'unknown';
      lastInstallErrorCode = code;
      if (key) lastMpsErrorByDevice.set(key, code);
      rejectPending(new Error(t('status.installFailed', { code })), key);
      continue;
    }
    if (name !== 'mpyVmEvent' || !value) continue;
    if (key) lastMpsEventByDevice.set(key, value);
    if (pendingLaunch && key && pendingLaunch.deviceKey !== key) continue;

    if (value === 'INSTALL_START' || value === 'INSTALL_SUCCESS') {
      state.launchPhase = 'preparing';
      state.message = t('status.preparing');
    } else if (READY_EVENTS.has(value)) {
      resolvePending(key);
    } else if (FAILED_EVENTS.has(value)) {
      rejectPending(launchErrorForFailedEvent(value, key), key);
    }
  }
}

function resolvePending(key = '') {
  if (!pendingLaunch) return;
  if (key && pendingLaunch.deviceKey !== key) return;
  const pending = pendingLaunch;
  pendingLaunch = null;
  window.clearTimeout(pending.timer);
  pending.resolve();
}

function rejectPending(error: Error, key = '') {
  if (!pendingLaunch) return;
  if (key && pendingLaunch.deviceKey !== key) return;
  const pending = pendingLaunch;
  pendingLaunch = null;
  window.clearTimeout(pending.timer);
  pending.reject(error);
}

function clearPendingLaunch() {
  if (!pendingLaunch) return;
  window.clearTimeout(pendingLaunch.timer);
  pendingLaunch = null;
}

function parseInstallErrorCode(value: string) {
  return value.match(/INSTALL_ERROR:([-+]?\d+)/)?.[1] || '';
}

function launchErrorForFailedEvent(value: string, key: string) {
  if (value === 'RUNNING_FAIL') {
    return new Error(t('status.runningFailed'));
  }
  const code = (key && lastMpsErrorByDevice.get(key)) || lastInstallErrorCode || 'unknown';
  return new Error(t('status.mpsInstallFailed', { code }));
}

function mpyExecReturnCode(response: unknown) {
  const data = response as { code?: unknown; result?: unknown; value?: unknown };
  const result = data?.result as { value?: unknown } | number | string | undefined;
  const value = typeof result === 'object' && result !== null ? result.value : result ?? data?.value;
  const code = Number(value);
  return Number.isFinite(code) ? code : Number(data?.code);
}

async function loadDevice(): Promise<DeviceInfo | null> {
  if (!hasBridge()) return { name: 'PixelMugS1 Mock', talId: 'PixelMugS1', slotId: 'mock' };
  // Follow the SDK multi-device example: getDevices() is the authoritative
  // shared binding list, and the returned object must be passed to callDevice.
  const allDevices = await webApp.getDevices() as DeviceInfo[];
  const devices = allDevices.filter(isPixelMugS1);
  validateBattleDevices(devices);

  const requestClient = webApp as BubbleWebApp & {
    request: (type: string, payload?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  };
  // The Bot resolves ownership again from the authoritative group slot list.
  // This request intentionally carries no client-provided binding snapshot.
  const reply = await requestClient.request('battle.resolveDevice') as any;
  battleResolution = reply?.result || null;
  if (!battleResolution?.deviceId) throw new Error(t('status.playerNotBound'));
  const exact = devices.find((item) => deviceKey(item) === battleResolution?.deviceId);
  if (!exact) {
    throw new Error(t('status.boundDeviceMissing'));
  }
  return exact;
}

async function activateDeviceRoute() {
  const requestClient = webApp as BubbleWebApp & {
    request: (type: string, payload?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  };
  await requestClient.request('battle.activateDevice');
}

async function syncBattleResult() {
  const requestClient = webApp as BubbleWebApp & {
    request: (type: string, payload?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  };
  const reply = await requestClient.request('battle.getState') as any;
  const snapshot = reply?.result || reply;
  const result = String(snapshot?.result || '').toLowerCase();
  if (TERMINAL_GAME_STATES.has(result)) state.gameState = result;
}

function validateBattleDevices(devices: DeviceInfo[]) {
  if (devices.length !== 2) throw new Error(t('status.twoDevicesRequired'));
  const slots = new Set(devices.map((item) => Number(item.slot)));
  if (!slots.has(1) || !slots.has(2)) throw new Error(t('status.twoSlotsRequired'));
  if (new Set(devices.map(deviceKey)).size !== 2) throw new Error(t('status.distinctDevicesRequired'));
  const owners = devices.map((item) => String(item.ownerId || rawDevice(item)?.ownerId || ''));
  if (owners.some((item) => !item) || new Set(owners).size !== 2) {
    throw new Error(t('status.distinctUsersRequired'));
  }
}

function isPixelMugS1(item: DeviceInfo) {
  const raw = item.raw as any;
  return [item.talId, item.deviceTalId, raw?.talId, raw?.device?.talId, raw?.slot?.talId]
    .filter(Boolean)
    .some((talId) => talId === 'PixelMugS1');
}

function rawDevice(item: DeviceInfo) {
  return (item.raw as { device?: Record<string, any> } | undefined)?.device || {};
}

function launchConfig() {
  const params = new URLSearchParams(location.search);
  return {
    id: cleanLaunchParam(battleResolution?.mps?.id || params.get('mps_id'), import.meta.env.VITE_MPS_ID || ''),
    version: cleanLaunchParam(battleResolution?.mps?.version || params.get('mps_version'), import.meta.env.VITE_MPS_VERSION || '1.1.1'),
  };
}

function cleanLaunchParam(value: string | null, fallback: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return fallback;
  return trimmed;
}

function deviceKey(target: DeviceInfo) {
  const raw = target.raw as { slot?: { id?: string | number }; device?: { id?: string | number } } | undefined;
  return String(
    target.deviceId
      || raw?.device?.id
      || target.slotId
      || raw?.slot?.id
      || `${target.talId || 'device'}:${target.slot || ''}`,
  );
}

function applyMessage(raw: unknown) {
  const message = raw as { state?: string; lines?: number; soundEnabled?: boolean } | undefined;
  if (!message) return;
  if (message.state) {
    const nextState = String(message.state).toLowerCase();
    const terminalLocked = TERMINAL_GAME_STATES.has(state.gameState)
      && !TERMINAL_GAME_STATES.has(nextState)
      && nextState !== 'join';
    if (!terminalLocked) state.gameState = nextState;
  }
  if (typeof message.lines === 'number') state.lines = Math.max(0, Math.floor(message.lines));
  if (typeof message.soundEnabled === 'boolean') state.soundEnabled = message.soundEnabled;
}

function responsePayload(response: unknown) {
  const item = response as any;
  return item?.result?.result || item?.result?.message || item?.message || item?.result || response;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || t('status.unknownError'));
  if (/requires device binding|\/attachdevice/i.test(message)) return t('status.deviceBindingRequired');
  return message;
}

function normalizeLeaderboardRow(value: any): LeaderboardRow | null {
  if (!value?.left?.userId || !value?.right?.userId) return null;
  return {
    left: normalizeLeaderboardPlayer(value.left),
    right: normalizeLeaderboardPlayer(value.right),
    games: Math.max(0, Math.floor(Number(value.games || 0))),
    lastPlayedAt: Math.max(0, Math.floor(Number(value.lastPlayedAt || 0))),
  };
}

function normalizeLeaderboardPlayer(value: any): LeaderboardPlayer {
  return {
    userId: String(value?.userId || ''),
    name: String(value?.name || t('leaderboard.player')),
    avatar: safeImageUrl(value?.avatar),
    wins: Math.max(0, Math.floor(Number(value?.wins || 0))),
  };
}

function normalizePersonalLeaderboardRow(value: any): PersonalLeaderboardRow | null {
  if (!value?.userId) return null;
  return {
    rank: Math.max(1, Math.floor(Number(value.rank || 1))),
    userId: String(value.userId),
    name: String(value.name || t('leaderboard.player')),
    avatar: safeImageUrl(value.avatar),
    bestLines: Math.max(0, Math.floor(Number(value.bestLines || 0))),
    updatedAt: Math.max(0, Math.floor(Number(value.updatedAt || 0))),
  };
}

function safeImageUrl(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}
