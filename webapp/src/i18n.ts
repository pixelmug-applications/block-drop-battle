import { computed, reactive } from 'vue';

export type AppLocale = 'zh-CN' | 'en-US';

const messages = {
  'zh-CN': {
    'landing.subtitle': '两位玩家，各自控制绑定的 PixelMugS1 实时对战',
    'landing.opening': '正在确认玩家并安装…',
    'landing.enter': '进入对战手柄',
    'landing.retry': '重试',
    'landing.install': '安装并打开',
    'status.findingDevice': '正在按当前用户查询绑定的 PixelMugS1…',
    'status.deviceMissing': '没有找到当前用户的对战设备。',
    'status.playerNotBound': '当前用户不在这场对战的绑定记录中。',
    'status.deviceBindingRequired': '此应用需要绑定设备。请发送“/attachdevice”，并按照提示绑定您的设备。',
    'status.boundDeviceMissing': '找不到记录中属于当前用户的 PixelMugS1，已停止安装。',
    'status.twoDevicesRequired': '必须先把两个设备槽都绑定为 PixelMugS1。',
    'status.twoSlotsRequired': '设备槽 1 和设备槽 2 必须全部绑定。',
    'status.distinctDevicesRequired': '两个设备槽不能绑定同一台设备。',
    'status.distinctUsersRequired': '两台设备必须分别属于两个不同用户。',
    'status.launching': '正在当前用户的水杯上启动方块落下对战版…',
    'status.preparing': '正在安装应用…',
    'status.switching': '正在切换应用…',
    'status.launchReady': '对战版已在正确的水杯上启动。',
    'status.spectator': '当前用户未绑定本群对战设备，可以查看排行榜。',
    'status.connectingBle': '应用已启动，正在连接 BLE…',
    'status.bleConnected': 'BLE 已连接。',
    'status.mockConnected': '浏览器模拟连接已就绪。',
    'status.bleConnectFailed': 'MPS 已启动，但 BLE 连接失败：{error}',
    'status.missingConfig': '缺少 MPS ID 或版本。',
    'status.openFailed': '无法打开应用（返回码 {code}）。',
    'status.launchTimeout': '无法确认应用已经启动。',
    'status.installFailed': '安装失败，错误码：{code}',
    'status.mpsInstallFailed': 'MPS 安装失败，错误码：{code}',
    'status.runningFailed': '安装成功，但应用内部启动失败。',
    'status.unknownError': '未知错误',
    'game.join': '加入对战',
    'game.waiting': '等待对手',
    'game.start': '开始',
    'game.playing': '对战中',
    'game.win': '本轮胜利',
    'game.lose': '本轮失败',
    'game.finished': '本轮结束',
    'game.soundOn': '声音开',
    'game.soundOff': '声音关',
    'game.soundEnable': '开启声音',
    'game.soundDisable': '关闭声音',
    'game.restart': '重新开始',
    'game.drop': '落下',
    'game.rotate': '旋转',
    'game.left': '左移',
    'game.right': '右移',
    'game.down': '下移',
    'ble.connected': '蓝牙（已连接）',
    'ble.connecting': '蓝牙（连接中，{seconds}s…）',
    'ble.timeout': '蓝牙（连接超时）',
    'ble.disconnected': '蓝牙（未连接）',
    'tabs.game': '游戏',
    'tabs.leaderboard': '排行榜',
    'leaderboard.back': '返回',
    'leaderboard.title': '群组对战榜',
    'leaderboard.refresh': '刷新战绩',
    'leaderboard.loading': '正在读取本群战绩…',
    'leaderboard.empty': '本群还没有已完成的对战',
    'leaderboard.games': '共 {games} 局',
    'leaderboard.player': '玩家',
  },
  'en-US': {
    'landing.subtitle': 'Two players battle in real time on their own bound PixelMugS1',
    'landing.opening': 'Verifying player and installing…',
    'landing.enter': 'Enter battle controller',
    'landing.retry': 'Retry',
    'landing.install': 'Install and open',
    'status.findingDevice': 'Finding the PixelMugS1 bound to the current user…',
    'status.deviceMissing': 'No battle device was found for the current user.',
    'status.playerNotBound': 'The current user is not registered in this battle.',
    'status.deviceBindingRequired': 'This application requires device binding. Send "/attachdevice" and follow the prompts to bind your device.',
    'status.boundDeviceMissing': 'The registered PixelMugS1 for this user is unavailable. Installation was stopped.',
    'status.twoDevicesRequired': 'Both device slots must be bound to PixelMugS1 devices first.',
    'status.twoSlotsRequired': 'Device slots 1 and 2 must both be bound.',
    'status.distinctDevicesRequired': 'The two slots cannot use the same device.',
    'status.distinctUsersRequired': 'The two devices must belong to different users.',
    'status.launching': 'Launching Block Drop Battle on your mug…',
    'status.preparing': 'Installing app…',
    'status.switching': 'Switching app…',
    'status.launchReady': 'Battle is running on the correct mug.',
    'status.spectator': 'No battle device is bound to this user. The leaderboard is available.',
    'status.connectingBle': 'App started. Connecting BLE…',
    'status.bleConnected': 'BLE connected.',
    'status.mockConnected': 'Browser mock connection is ready.',
    'status.bleConnectFailed': 'MPS started, but BLE failed: {error}',
    'status.missingConfig': 'MPS ID or version is missing.',
    'status.openFailed': 'Could not open app (code {code}).',
    'status.launchTimeout': 'Could not confirm the app opened.',
    'status.installFailed': 'Installation failed. Error code: {code}',
    'status.mpsInstallFailed': 'MPS installation failed. Error code: {code}',
    'status.runningFailed': 'Installation succeeded, but the app failed to start.',
    'status.unknownError': 'Unknown error',
    'game.join': 'Join battle',
    'game.waiting': 'Waiting for rival',
    'game.start': 'Start',
    'game.playing': 'Playing',
    'game.win': 'Victory',
    'game.lose': 'Defeat',
    'game.finished': 'Round finished',
    'game.soundOn': 'Sound on',
    'game.soundOff': 'Sound off',
    'game.soundEnable': 'Enable sound',
    'game.soundDisable': 'Disable sound',
    'game.restart': 'Restart',
    'game.drop': 'Drop',
    'game.rotate': 'Rotate',
    'game.left': 'Left',
    'game.right': 'Right',
    'game.down': 'Down',
    'ble.connected': 'Bluetooth (connected)',
    'ble.connecting': 'Bluetooth (connecting, {seconds}s…)',
    'ble.timeout': 'Bluetooth (connection timed out)',
    'ble.disconnected': 'Bluetooth (disconnected)',
    'tabs.game': 'Game',
    'tabs.leaderboard': 'Leaderboard',
    'leaderboard.back': 'Back',
    'leaderboard.title': 'Group Battle Leaderboard',
    'leaderboard.refresh': 'Refresh scores',
    'leaderboard.loading': 'Loading this group’s results…',
    'leaderboard.empty': 'No completed battles in this group yet',
    'leaderboard.games': '{games} games',
    'leaderboard.player': 'Player',
  },
} as const;

export type MessageKey = keyof typeof messages['en-US'];
const state = reactive({ locale: detectLocale() });
export const currentLocale = computed(() => state.locale);

export function setLocale(locale: string | null | undefined) {
  state.locale = normalizeLocale(locale);
}

export function t(key: MessageKey, params: Record<string, string | number> = {}) {
  let text: string = messages[state.locale][key] || messages['en-US'][key] || key;
  for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

function detectLocale(): AppLocale {
  const queryLocale = new URLSearchParams(globalThis.location?.search || '').get('lang');
  const bridgeLocale = (globalThis as { JeeWeb?: { Language?: string } }).JeeWeb?.Language;
  return normalizeLocale(queryLocale || bridgeLocale || globalThis.navigator?.language);
}

function normalizeLocale(value: string | null | undefined): AppLocale {
  return String(value || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}
