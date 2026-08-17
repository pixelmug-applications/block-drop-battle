<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useBlockDropDevice, type BlockDropCommand, type LeaderboardPlayer } from './device';
import { t } from './i18n';

const game = useBlockDropDevice();
const entered = ref(false);
const prepared = ref(false);
const busy = ref(false);
const error = ref('');
const pressed = ref<BlockDropCommand | ''>('');
const activeView = ref<'game' | 'leaderboard'>('game');
let repeatTimer: number | undefined;
let bleCountdownTimer: number | undefined;
let stateSyncTimer: number | undefined;
let resumeRefreshTimer: number | undefined;
const bleSeconds = ref(20);

const bleLabel = computed(() => {
  if (game.ready.value) return t('ble.connected');
  if (game.connecting.value) return t('ble.connecting', { seconds: bleSeconds.value });
  if (game.state.connection === 'failed') return t('ble.timeout');
  return t('ble.disconnected');
});

const canReconnect = computed(() => game.canControl.value && !game.ready.value && !game.connecting.value);

async function openGame() {
  if (prepared.value) {
    entered.value = true;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const canPlay = await game.openOnDevice();
    prepared.value = true;
    if (!canPlay) {
      entered.value = true;
      return;
    }
    void game.connectDevice();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    busy.value = false;
  }
}

function tap(command: BlockDropCommand) {
  pressed.value = command;
  void game.send(command);
  window.setTimeout(() => { if (pressed.value === command) pressed.value = ''; }, 100);
}

function joinOrStart() {
  if (game.state.gameState === 'join') tap('JOIN');
  else if (game.state.gameState === 'go') tap('START');
  else void game.refreshState(true);
}

const actionLabel = computed(() => {
  if (game.state.gameState === 'join') return t('game.join');
  if (game.state.gameState === 'ready') return t('game.waiting');
  if (game.state.gameState === 'go') return t('game.start');
  if (game.state.gameState === 'playing') return t('game.playing');
  if (game.state.gameState === 'win') return t('game.win');
  if (game.state.gameState === 'lose') return t('game.lose');
  return t('game.finished');
});

const canPlay = computed(() => game.canControl.value && game.ready.value && game.state.gameState === 'playing');
const canPrimaryAction = computed(() => {
  if (!game.canControl.value) return false;
  if (['join', 'go'].includes(game.state.gameState)) return game.ready.value;
  return ['ready', 'playing', 'finished', 'win', 'lose'].includes(game.state.gameState);
});
const canRestart = computed(() => game.canControl.value && game.ready.value && ['win', 'lose'].includes(game.state.gameState));

function hold(command: 'LEFT' | 'RIGHT' | 'DOWN', event: PointerEvent) {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  stopHold();
  pressed.value = command;
  void game.send(command);
  repeatTimer = window.setInterval(() => void game.send(command), command === 'DOWN' ? 75 : 105);
}

function stopHold() {
  window.clearInterval(repeatTimer);
  repeatTimer = undefined;
  pressed.value = '';
}

function refreshAfterResume() {
  if (!entered.value || document.visibilityState === 'hidden') return;
  window.clearTimeout(resumeRefreshTimer);
  resumeRefreshTimer = window.setTimeout(() => {
    if (activeView.value === 'leaderboard') void game.loadLeaderboard(true);
    else void game.refreshState(true);
  }, 150);
}

function switchView(view: 'game' | 'leaderboard') {
  activeView.value = view;
  if (view === 'leaderboard') void game.loadLeaderboard();
}

function playerInitial(player: LeaderboardPlayer) {
  return Array.from(player.name.trim() || '?')[0]?.toUpperCase() || '?';
}

function hideBrokenAvatar(player: LeaderboardPlayer) {
  player.avatar = '';
}

watch(
  () => game.connecting.value,
  (connecting) => {
    window.clearInterval(bleCountdownTimer);
    bleSeconds.value = 20;
    if (!connecting) return;
    bleCountdownTimer = window.setInterval(() => {
      bleSeconds.value = Math.max(0, bleSeconds.value - 1);
    }, 1000);
  },
  { immediate: true },
);

// Opening the inline-keyboard URL is the authorization/install trigger.
// The landing page immediately resolves the clicking user and exact device.
onMounted(() => {
  void openGame();
  stateSyncTimer = window.setInterval(() => {
    if (!entered.value || !['go', 'playing', 'finished'].includes(game.state.gameState)) return;
    void game.refreshState();
  }, 1000);
  document.addEventListener('visibilitychange', refreshAfterResume);
  window.addEventListener('pageshow', refreshAfterResume);
  window.addEventListener('focus', refreshAfterResume);
});

onBeforeUnmount(() => {
  stopHold();
  window.clearInterval(bleCountdownTimer);
  window.clearInterval(stateSyncTimer);
  window.clearTimeout(resumeRefreshTimer);
  document.removeEventListener('visibilitychange', refreshAfterResume);
  window.removeEventListener('pageshow', refreshAfterResume);
  window.removeEventListener('focus', refreshAfterResume);
});
</script>

<template>
  <main v-if="!entered" class="landing" :class="{ ready: prepared }">
    <section class="landing-content">
      <div class="tetromino" aria-hidden="true"><i /><i /><i /><i /></div>
      <h1><span>BLOCK DROP</span><span class="battle-title">BATTLE</span></h1>
      <p>{{ t('landing.subtitle') }}</p>
    </section>
    <section class="landing-actions">
      <button :disabled="busy" @click="openGame">
        {{ busy ? t('landing.opening') : prepared ? t('landing.enter') : error ? t('landing.retry') : t('landing.install') }}
      </button>
      <p
        v-if="busy || prepared || error || game.state.message"
        class="install-status"
        :class="{
          error: Boolean(error) && !prepared,
          success: prepared,
        }"
      >
        {{ prepared ? t('status.launchReady') : error || game.state.message }}
      </p>
    </section>
  </main>

  <template v-else>
  <main
    v-if="activeView === 'game'"
    class="controller"
    :class="{ offline: !game.ready.value || !game.canControl.value, spectator: !game.canControl.value }"
  >
    <section class="utility-row">
      <button
        class="small green"
        :class="{ pressed: pressed === 'JOIN' || pressed === 'START' }"
        :disabled="!canPrimaryAction"
        @click="joinOrStart"
      >
        <i />{{ actionLabel }}
      </button>
      <button
        class="small green"
        :class="{ pressed: pressed === 'SOUND', muted: !game.state.soundEnabled }"
        :title="game.state.soundEnabled ? t('game.soundDisable') : t('game.soundEnable')"
        :disabled="!game.canControl.value || !game.ready.value"
        @click="tap('SOUND')"
      ><i />{{ game.state.soundEnabled ? t('game.soundOn') : t('game.soundOff') }}</button>
      <button class="small red" :class="{ pressed: pressed === 'RESTART' }" :disabled="!canRestart" @click="tap('RESTART')"><i />{{ t('game.restart') }}</button>
      <button
        class="small blue ble-control"
        :class="{ connecting: game.connecting.value }"
        :disabled="!canReconnect"
        @click="game.reconnect"
      ><i />{{ bleLabel }}</button>
      <button
        class="small purple leaderboard-control"
        @click="switchView('leaderboard')"
      ><i />{{ t('tabs.leaderboard') }}</button>
    </section>

    <button class="drop blue" :class="{ pressed: pressed === 'DROP' }" :disabled="!canPlay" @pointerdown.prevent="tap('DROP')">
      <i />{{ t('game.drop') }}
    </button>

    <section class="dpad">
      <button class="round blue up" :class="{ pressed: pressed === 'ROTATE' }" :disabled="!canPlay" @pointerdown.prevent="tap('ROTATE')"><i />{{ t('game.rotate') }}</button>
      <button class="round blue left" :class="{ pressed: pressed === 'LEFT' }" :disabled="!canPlay" @pointerdown.prevent="hold('LEFT', $event)" @pointerup.prevent="stopHold" @pointercancel.prevent="stopHold"><i />{{ t('game.left') }}</button>
      <button class="round blue right" :class="{ pressed: pressed === 'RIGHT' }" :disabled="!canPlay" @pointerdown.prevent="hold('RIGHT', $event)" @pointerup.prevent="stopHold" @pointercancel.prevent="stopHold"><i />{{ t('game.right') }}</button>
      <button class="round blue down" :class="{ pressed: pressed === 'DOWN' }" :disabled="!canPlay" @pointerdown.prevent="hold('DOWN', $event)" @pointerup.prevent="stopHold" @pointercancel.prevent="stopHold"><i />{{ t('game.down') }}</button>
    </section>
  </main>

  <main v-else class="leaderboard-page">
    <header class="leaderboard-hero">
      <button class="leaderboard-back" @click="switchView('game')">
        <span aria-hidden="true">←</span>{{ t('leaderboard.back') }}
      </button>
      <div class="pixel-crown" aria-hidden="true">♛</div>
      <h2>{{ t('leaderboard.title') }}</h2>
      <p>{{ t('leaderboard.subtitle') }}</p>
      <strong v-if="game.leaderboard.groupName">{{ game.leaderboard.groupName }}</strong>
      <i class="hero-block block-a" /><i class="hero-block block-b" />
      <i class="hero-block block-c" /><i class="hero-block block-d" />
    </header>

    <section class="leaderboard-content">
      <button
        class="leaderboard-refresh"
        :disabled="game.leaderboard.loading"
        @click="game.loadLeaderboard(true)"
      >↻ {{ t('leaderboard.refresh') }}</button>

      <p v-if="game.leaderboard.loading && !game.leaderboard.rows.length" class="leaderboard-status">
        {{ t('leaderboard.loading') }}
      </p>
      <p v-else-if="game.leaderboard.error && !game.leaderboard.rows.length" class="leaderboard-status error">
        {{ game.leaderboard.error }}
      </p>
      <p v-else-if="!game.leaderboard.rows.length" class="leaderboard-status">
        {{ t('leaderboard.empty') }}
      </p>

      <div v-else class="leaderboard-list">
        <article v-for="row in game.leaderboard.rows" :key="`${row.left.userId}:${row.right.userId}`" class="matchup-card">
          <div class="rank-player left-player">
            <div class="rank-avatar">
              <span>{{ playerInitial(row.left) }}</span>
              <img v-if="row.left.avatar" :src="row.left.avatar" :alt="row.left.name" @error="hideBrokenAvatar(row.left)" />
            </div>
            <div class="rank-identity">
              <b>{{ row.left.name }}</b>
              <strong>{{ row.left.wins }}</strong>
            </div>
          </div>

          <div class="rank-pk">
            <span>PK</span>
            <small>{{ t('leaderboard.games', { games: row.games }) }}</small>
          </div>

          <div class="rank-player right-player">
            <div class="rank-identity">
              <b>{{ row.right.name }}</b>
              <strong>{{ row.right.wins }}</strong>
            </div>
            <div class="rank-avatar">
              <span>{{ playerInitial(row.right) }}</span>
              <img v-if="row.right.avatar" :src="row.right.avatar" :alt="row.right.name" @error="hideBrokenAvatar(row.right)" />
            </div>
          </div>
        </article>
      </div>
    </section>
  </main>
  </template>
</template>
