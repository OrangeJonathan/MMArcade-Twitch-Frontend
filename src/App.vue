<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { TwitchApiClient } from './services/twitchApi'
import type { EngagementResponse, PollSummary, SkipStatistics, StreamRotation } from './types/twitch'

type View = 'overview' | 'director' | 'multistream' | 'engagement'


const defaultBackendUrl = `http://${window.location.hostname}:5071`

// Arcade Dome
// const defaultBackendUrl = 'http://10.10.20.83:5071'
const configuredApiBaseUrl = import.meta.env.VITE_TWITCH_API_BASE_URL ?? defaultBackendUrl

// Laptop
function useLocalHttpBackend(url: string) {
  return url
    .replace('https://192.168.4.73:7028', 'http://192.168.4.73:5071')
}

// Arcade Dome
// function useLocalHttpBackend(url: string) {
//   return url
//     .replace('https://10.10.20.83:7028', 'http://10.10.20.83:5071')
//     .replace('https://10.10.20.83:7028', 'http://10.10.20.83:5071')
// }

const config = reactive({
  apiBaseUrl: useLocalHttpBackend(configuredApiBaseUrl),
  broadcasterId: '876318030',
  chatChannel: 'mmarcadebnl',
})
const isObsOverlay = typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/obs-overlay'
const obsStreamerName = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('streamer')?.trim() ?? ''
  : ''
const modules = reactive({
  streamSwitchEnabled: true,
})
const view = ref<View>('overview')
const isBusy = ref(false)
const notice = ref('')
const announcement = ref<{ type: 'rotation' | 'poll'; message: string } | null>(null)
const polls = ref<PollSummary[]>([])
const rotation = ref<StreamRotation>({
  activeStreamer: 'Streamer 1',
  streamerOne: 'Streamer 1',
  streamerTwo: 'Streamer 2',
  turnEndsAt: '',
  durationMinutes: 30,
  isRunning: false,
})
const pollForm = reactive({ title: '', choices: 'Streamer 1\nStreamer 2', duration: 60 })
const rotationForm = reactive({ streamerOne: '', streamerTwo: '', durationMinutes: 30 })
const streamerName = ref('')
const skipStatistics = ref<SkipStatistics>({
  turnNumber: 0,
  viewerCount: 0,
  count: 0,
  uniqueViewers: 0,
  percentage: 0,
})
const engagement = ref<EngagementResponse>({ currentStreamId: null, current: null, history: [] })
let pollRefreshTimer: number | undefined
let rotationRefreshTimer: number | undefined
let skipStatisticsRefreshTimer: number | undefined
let engagementRefreshTimer: number | undefined
let dashboardStateInitialized = false

const api = computed(() => new TwitchApiClient(config.apiBaseUrl))
const activePoll = computed(() => polls.value.find((poll) => poll.status.toLowerCase() === 'active') ?? null)
const winners = computed(() => {
  const ended = polls.value.find((poll) => poll.status.toLowerCase() !== 'active')
  if (!ended || ended.choices.length === 0) return []

  const highestVoteCount = Math.max(...ended.choices.map((choice) => choice.votes))
  return ended.choices.filter((choice) => choice.votes === highestVoteCount)
})
const latestCompletedPoll = computed(() => polls.value.find((poll) => poll.status.toLowerCase() !== 'active') ?? null)
const loggedInStreamer = computed(() => streamerName.value.trim())
const obsIsActiveStreamer = computed(() =>
  Boolean(obsStreamerName) &&
  obsStreamerName.toLowerCase() === rotation.value.activeStreamer.trim().toLowerCase(),
)
const isMyTurn = computed(() =>
  Boolean(loggedInStreamer.value) &&
  loggedInStreamer.value.toLowerCase() === rotation.value.activeStreamer.trim().toLowerCase(),
)
const engagementHistory = computed(() => engagement.value.history.slice(-96))
const engagementMaxViewers = computed(() =>
  Math.max(...engagementHistory.value.map((snapshot) => snapshot.viewerCount), 1),
)
const twitchChatUrl = computed(() => {
  const channel = encodeURIComponent(config.chatChannel.trim().replace(/^#/, '').toLowerCase())
  const parent = encodeURIComponent(typeof window === 'undefined' ? 'localhost' : window.location.hostname)
  return `https://www.twitch.tv/embed/${channel}/chat?parent=${parent}&darkpopout`
})
const isIpAddress = computed(() => {
  const hostname = typeof window === 'undefined' ? 'localhost' : window.location.hostname
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
})

function record(value: unknown, keys: string[], fallback = ''): string {
  if (!value || typeof value !== 'object') return fallback
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (typeof candidate === 'number') return String(candidate)
  }
  return fallback
}

function number(value: unknown, keys: string[], fallback = 0): number {
  const parsed = Number(record(value, keys, String(fallback)))
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'items', 'polls', 'result']) {
      const value = (payload as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3 ) | 0x8;
    return v.toString(16);  });  
}

function normalizePoll(raw: unknown): PollSummary {
  const choices = (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).choices)
    ? (raw as Record<string, unknown>).choices
    : []) as unknown[]
  const total = choices.reduce<number>((sum, choice) => sum + number(choice, ['votes', 'totalVotes'], 0), 0)
  return {
    id: record(raw, ['id', 'pollId'], generateId()),
    title: record(raw, ['title', 'question'], 'Untitled poll'),
    status: record(raw, ['status', 'state'], 'UNKNOWN'),
    endsAt: record(raw, ['endedAt', 'endsAt', 'expiresAt']),
    votes: number(raw, ['totalVotes', 'votes', 'voterCount'], total),
    choices: choices.map((choice) => {
      const votes = number(choice, ['votes', 'totalVotes'], 0)
      return {
        id: record(choice, ['id', 'choiceId']),
        title: record(choice, ['title', 'text', 'label'], 'Option'),
        votes,
        percentage: total ? Math.round((votes / total) * 100) : 0,
      }
    }),
  }
}

function addNotice(message: string) {
  notice.value = message
  window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 4500)
}

function announce(type: 'rotation' | 'poll', message: string) {
  announcement.value = { type, message }
}

function loginStreamer() {
  const name = streamerName.value.trim()
  if (!name) {
    addNotice('Enter your streamer name before logging in.')
    return
  }
  streamerName.value = name
  localStorage.setItem('mm-arcade-streamer-name', name)
  addNotice(`Logged in as ${name}.`)
}

function logoutStreamer() {
  streamerName.value = ''
  localStorage.removeItem('mm-arcade-streamer-name')
  addNotice('Streamer login cleared for this screen.')
}

watch(
  () => rotation.value.activeStreamer,
  (activeStreamer, previousStreamer) => {
    if (dashboardStateInitialized && previousStreamer && activeStreamer !== previousStreamer) {
      announce('rotation', `Streamer switched to ${activeStreamer}`)
    }
  },
)

watch(
  () => ({ activePollId: activePoll.value?.id ?? '', completedPollId: latestCompletedPoll.value?.id ?? '' }),
  (state, previousState) => {
    if (
      dashboardStateInitialized &&
      previousState?.activePollId &&
      !state.activePollId &&
      state.completedPollId
    ) {
      const completedPoll = latestCompletedPoll.value
      const tiedWinners = completedPoll
        ? completedPoll.choices
            .filter((choice) => choice.votes === Math.max(...completedPoll.choices.map((item) => item.votes)))
            .map((choice) => choice.title)
        : []
      announce('poll', tiedWinners.length ? `Poll result: ${tiedWinners.join(' and ')} won` : 'Poll finished')
    }
  },
  { deep: true },
)

async function loadData() {
  if (!config.broadcasterId.trim()) {
    addNotice('Enter a broadcaster ID before loading channel data.')
    return
  }

  isBusy.value = true
  try {
    const [pollPayload, rotationPayload] = await Promise.all([
      api.value.getPolls(config.broadcasterId.trim()),
      api.value.getRotation(),
    ])
    polls.value = parseList(pollPayload).map(normalizePoll)
    rotation.value = { ...rotation.value, ...rotationPayload }
    await refreshSkipStatistics()
    await nextTick()
    dashboardStateInitialized = true
    addNotice('Dashboard refreshed.')
  } catch (error) {
    addNotice(error instanceof Error ? error.message : 'Could not load dashboard data.')
  } finally {
    isBusy.value = false
  }
}

async function refreshSkipStatistics() {
  if (!config.broadcasterId.trim()) return

  try {
    skipStatistics.value = await api.value.getSkipStatistics(config.broadcasterId.trim())
  } catch (error) {
    addNotice(error instanceof Error ? `Skip statistics refresh failed: ${error.message}` : 'Skip statistics refresh failed.')
  }
}

async function refreshEngagement() {
  try {
    engagement.value = await api.value.getEngagement()
  } catch (error) {
    addNotice(error instanceof Error ? `Engagement refresh failed: ${error.message}` : 'Engagement refresh failed.')
  }
}

async function resetSkipStatistics() {
  try {
    await api.value.resetSkipStatistics()
    await refreshSkipStatistics()
    addNotice('Game votes reset.')
  } catch (error) {
    addNotice(error instanceof Error ? `Could not reset game votes: ${error.message}` : 'Could not reset game votes.')
  }
}

async function refreshPolls() {
  if (!config.broadcasterId.trim() || isBusy.value) return

  try {
    const pollPayload = await api.value.getPolls(config.broadcasterId.trim())
    polls.value = parseList(pollPayload).map(normalizePoll)
  } catch (error) {
    addNotice(error instanceof Error ? `Poll refresh failed: ${error.message}` : 'Poll refresh failed.')
  }

}

async function refreshRotation() {
  try {
    rotation.value = await api.value.getRotation()
  } catch (error) {
    addNotice(error instanceof Error ? `Rotation refresh failed: ${error.message}` : 'Rotation refresh failed.')
  }
}

async function createPoll() {
  const choices = pollForm.choices.split(/\r?\n/).map((choice) => choice.trim()).filter(Boolean)
  if (!config.broadcasterId.trim() || !pollForm.title.trim() || choices.length < 2) {
    addNotice('Add a broadcaster ID, poll title, and at least two choices.')
    return
  }
  isBusy.value = true
  try {
    await api.value.createPoll({
      broadcaster_id: config.broadcasterId.trim(),
      title: pollForm.title.trim(),
      choices: choices.map((title) => ({ title })),
      duration: pollForm.duration,
    })
    pollForm.title = ''
    addNotice('Poll started.')
    await loadData()
  } catch (error) {
    addNotice(error instanceof Error ? error.message : 'Could not start poll.')
  } finally {
    isBusy.value = false
  }
}

async function endPoll() {
  if (!activePoll.value || !config.broadcasterId.trim()) return
  isBusy.value = true
  try {
    await api.value.endPoll({ broadcasterId: config.broadcasterId.trim(), pollId: activePoll.value.id })
    addNotice('Poll ended.')
    await loadData()
  } catch (error) {
    addNotice(error instanceof Error ? error.message : 'Could not end poll.')
  } finally {
    isBusy.value = false
  }
}

async function saveRotation() {
  try {
    rotation.value = await api.value.updateRotation({
      streamerOne: rotationForm.streamerOne || rotation.value.streamerOne,
      streamerTwo: rotationForm.streamerTwo || rotation.value.streamerTwo,
      activeStreamer: rotation.value.activeStreamer,
    })
    addNotice('Rotation saved for every connected streamer.')
  } catch (error) {
    addNotice(error instanceof Error ? error.message : 'Could not save rotation.')
  }
}

async function advanceRotation() {
  if (!modules.streamSwitchEnabled) {
    addNotice('Enable the Stream Switch module before switching streamers.')
    return
  }

  try {
    rotation.value = await api.value.advanceRotation()
    addNotice(`${rotation.value.activeStreamer} is now on.`)
  } catch (error) {
    addNotice(error instanceof Error ? error.message : 'Could not advance rotation.')
  }

}

function toggleStreamSwitch() {
  modules.streamSwitchEnabled = !modules.streamSwitchEnabled
  localStorage.setItem('mm-arcade-stream-switch-enabled', String(modules.streamSwitchEnabled))
  addNotice(modules.streamSwitchEnabled ? 'Stream Switch module enabled.' : 'Stream Switch module disabled for this stream.')
}

function formatTime(value: string) {
  if (!value) return '—'
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

onMounted(() => {
  if (isObsOverlay) {
    document.body.classList.add('obs-page')
    void refreshRotation()
    rotationRefreshTimer = window.setInterval(() => {
      void refreshRotation()
    }, 2000)
    return
  }

  modules.streamSwitchEnabled = localStorage.getItem('mm-arcade-stream-switch-enabled') !== 'false'
  streamerName.value = localStorage.getItem('mm-arcade-streamer-name') ?? ''
  void loadData()
  pollRefreshTimer = window.setInterval(() => {
    void refreshPolls()
  }, 5000)
  rotationRefreshTimer = window.setInterval(() => {
    void refreshRotation()
  }, 2000)
  skipStatisticsRefreshTimer = window.setInterval(() => {
    void refreshSkipStatistics()
  }, 5000)
  engagementRefreshTimer = window.setInterval(() => {
    void refreshEngagement()
  }, 15000)
  void refreshEngagement()
})
onBeforeUnmount(() => {
  document.body.classList.remove('obs-page')
  if (pollRefreshTimer !== undefined) {
    window.clearInterval(pollRefreshTimer)
  }
  if (rotationRefreshTimer !== undefined) {
    window.clearInterval(rotationRefreshTimer)
  }
  if (skipStatisticsRefreshTimer !== undefined) {
    window.clearInterval(skipStatisticsRefreshTimer)
  }
  if (engagementRefreshTimer !== undefined) {
    window.clearInterval(engagementRefreshTimer)
  }
})
</script>

<template>
  <div v-if="isObsOverlay" class="obs-overlay" role="status" aria-live="polite">
    <div class="obs-overlay__accent"></div>
    <div class="obs-overlay__content" :class="{ active: obsIsActiveStreamer, inactive: Boolean(obsStreamerName) && !obsIsActiveStreamer }">
      <span class="kicker">MM ARCADE · LIVE ROTATION</span>
      <p class="obs-overlay__label">NOW LIVE</p>
      <strong v-if="rotation.activeStreamer">{{ rotation.activeStreamer }}</strong>
      <strong v-else class="obs-overlay__loading">Connecting...</strong>
      <span v-if="obsStreamerName" class="obs-overlay__status" :class="{ active: obsIsActiveStreamer, inactive: !obsIsActiveStreamer }">
        {{ obsIsActiveStreamer ? 'YOUR TURN' : `Waiting for ${rotation.activeStreamer}` }}
      </span>
    </div>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">M</span><div><strong>Arcade Control</strong><small>STREAM OPERATIONS</small></div></div>
      <nav class="nav">
        <button v-for="item in [
          ['overview', 'Overview', '⌂'],
          ['director', 'Director', '◈'],
          ['multistream', 'Multistream', '↻'],
          ['engagement', 'Engagement', '◉'],
        ]" :key="item[0]" :class="{ active: view === item[0] }" @click="view = item[0] as View"><span>{{ item[2] }}</span>{{ item[1] }}</button>
      </nav>
    </aside>

    <main class="main">
      <header class="topbar"><div><p class="kicker">MEDIA MARKT ARCADE</p><h1>{{ view === 'overview' ? 'Good evening, operator.' : view === 'director' ? 'Director' : view === 'multistream' ? 'Multistream' : 'Stream engagement' }}</h1></div><div class="topbar-actions"><input v-model="config.broadcasterId" placeholder="Broadcaster ID" /><button class="button button-primary" :disabled="isBusy" @click="loadData">Refresh</button></div></header>
      <div v-if="announcement" class="announcement" :class="`announcement--${announcement.type}`" role="status">
        <strong>{{ announcement.type === 'rotation' ? 'STREAM SWITCH' : 'POLL RESULT' }}</strong>
        <span>{{ announcement.message }}</span>
        <button type="button" aria-label="Dismiss notification" @click="announcement = null">×</button>
      </div>
      <div v-if="notice" class="notice">{{ notice }}</div>

      <template v-if="view === 'overview'">
        <section class="section-heading overview-heading"><div><p class="kicker">STREAM WORKSPACE</p><h2>Choose the tools for this stream.</h2><p class="muted">Keep the control room focused on the modules you actually need today.</p></div><div class="hero-date">{{ new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) }}</div></section>
        <section class="module-grid">
          <article class="module-card module-card--featured"><div class="module-icon">◈</div><div><span class="kicker">DIRECTOR</span><h3>Director controls</h3><p>Poll the audience, check !skip and change the active streamer.</p></div><button class="button button-primary" @click="view = 'director'">Open Director</button></article>
          <article class="module-card" :class="{ 'module-card--disabled': !modules.streamSwitchEnabled }"><div class="module-card__top"><div class="module-icon">↻</div><span class="status-pill" :class="{ green: modules.streamSwitchEnabled }">{{ modules.streamSwitchEnabled ? 'ENABLED' : 'DISABLED' }}</span></div><span class="kicker">STREAMER VIEW</span><h3>Multistream</h3><p>Show the active streamer, streamer login and Twitch chat on one screen.</p><div class="module-actions"><button class="button" @click="toggleStreamSwitch">{{ modules.streamSwitchEnabled ? 'Disable for this stream' : 'Enable for this stream' }}</button><button class="text-button" :disabled="!modules.streamSwitchEnabled" @click="view = 'multistream'">Open Multistream →</button></div></article>
        </section>
        <section class="overview-grid"><article class="card"><div class="card-header"><div><span class="kicker">STREAM SNAPSHOT</span><h3>Right now</h3></div><button class="text-button" :disabled="isBusy" @click="loadData">Refresh</button></div><div class="snapshot-list"><div><span>Poll</span><strong>{{ activePoll ? 'Running' : 'No active poll' }}</strong><small>{{ activePoll?.title || 'Ready for the next audience question' }}</small></div><div><span>Multistream</span><strong>{{ modules.streamSwitchEnabled ? rotation.activeStreamer : 'Module disabled' }}</strong><small>{{ modules.streamSwitchEnabled ? 'Shared state is synced between clients' : 'Enable it from the module card above' }}</small></div></div></article><article class="card"><div class="card-header"><div><span class="kicker">NEXT ACTIONS</span><h3>Quick start</h3></div></div><div class="quick-actions"><button @click="view = 'director'">Open Director <span>→</span></button><button :disabled="!modules.streamSwitchEnabled" @click="view = 'multistream'">Open Multistream <span>→</span></button></div></article></section>
      </template>

      <template v-else-if="view === 'director'">
        <section class="section-heading"><div><p class="kicker">DIRECTOR</p><h2>Make the call quickly.</h2></div><span class="muted">Poll, review !skip and switch manually.</span></section>
        <section class="content-grid"><article class="card"><div class="card-header"><div><span class="kicker">NEW POLL</span><h3>Ask the audience</h3></div></div><label>Question<input v-model="pollForm.title" placeholder="Which streamer should be on screen?" /></label><label>Choices <small>one per line</small><textarea v-model="pollForm.choices" rows="4"></textarea></label><label>Duration in seconds<input v-model.number="pollForm.duration" type="number" min="15" max="1800" /></label><button class="button button-primary full" :disabled="isBusy" @click="createPoll">Start poll</button></article><article class="card"><div class="card-header"><div><span class="kicker">CURRENT POLL</span><h3>{{ activePoll?.title || 'No active poll' }}</h3></div><button v-if="activePoll" class="button button-danger" @click="endPoll">End poll</button></div><div v-if="activePoll" class="result-list"><div v-for="choice in activePoll.choices" :key="choice.title" class="result-row"><div class="result-label"><span>{{ choice.title }}</span><strong>{{ choice.votes }} <small>{{ choice.percentage }}%</small></strong></div><div class="bar"><i :style="{ width: `${choice.percentage}%` }"></i></div></div></div><div v-else-if="winners.length" class="winner">Winner<span v-for="winner in winners" :key="winner.title"><strong>{{ winner.title }}</strong></span></div><div v-else class="empty">Your latest poll results will appear here.</div></article></section>
        <section class="director-controls">
          <article class="card director-active-card"><div class="card-header"><div><span class="kicker">ACTIVE STREAMER</span><h3>{{ rotation.activeStreamer }}</h3></div><span class="status-pill green">LIVE</span></div><p class="muted">This is the streamer currently shown to viewers.</p><button class="button button-primary full" :disabled="!modules.streamSwitchEnabled" @click="advanceRotation">Switch streamer</button></article>
          <article class="card skip-stats-card"><div class="card-header"><div><span class="kicker">!SKIP COUNTER</span><h3>Chat wants a change?</h3></div><span class="status-pill">MANUAL</span></div><div class="skip-stats-grid"><div><span>Viewers</span><strong>{{ skipStatistics.viewerCount }}</strong><small>Current viewers</small></div><div><span>!skip</span><strong>{{ skipStatistics.count }}</strong><small>{{ skipStatistics.uniqueViewers }} unique · {{ skipStatistics.percentage }}%</small></div></div><button class="button button-danger full" @click="resetSkipStatistics">Reset votes</button></article>
        </section>
        <section class="card director-settings"><div><span class="kicker">MULTISTREAM SETUP</span><h3>Two-streamer setup</h3></div><div class="rotation-settings"><label>Streamer one<input v-model="rotationForm.streamerOne" :placeholder="rotation.streamerOne" /></label><label>Streamer two<input v-model="rotationForm.streamerTwo" :placeholder="rotation.streamerTwo" /></label><label>Minutes per turn<input v-model.number="rotationForm.durationMinutes" type="number" min="1" max="240" /></label><button class="button button-primary" @click="saveRotation">Save shared state</button></div></section>
      </template>

      <template v-else-if="view === 'multistream'">
        <section class="section-heading"><div><p class="kicker">MULTISTREAM</p><h2>Everyone sees the same turn.</h2><p class="muted">Your streamer identity, the active streamer and Twitch chat in one view.</p></div><div class="module-actions"><button class="button" @click="toggleStreamSwitch">{{ modules.streamSwitchEnabled ? 'Disable module' : 'Enable module' }}</button></div></section>
        <div v-if="!modules.streamSwitchEnabled" class="module-disabled-banner"><strong>Stream Switch is disabled.</strong><span>Enable the module to configure turns and notify the streamers.</span></div>
        <section class="rotation-layout">
          <div class="rotation-column">
            <article class="rotation-card" :class="{ 'rotation-card--my-turn': isMyTurn, 'rotation-card--not-my-turn': Boolean(loggedInStreamer) && !isMyTurn }">
              <span class="live-label" :class="{ 'live-label--red': Boolean(loggedInStreamer) && !isMyTurn }"><i></i> {{ isMyTurn ? 'YOUR TURN' : 'CURRENTLY ON' }}</span>
              <strong>{{ isMyTurn ? loggedInStreamer : rotation.activeStreamer }}</strong>
              <p v-if="isMyTurn">You are live now. The other screen is on standby.</p>
              <p v-else-if="loggedInStreamer">Stand by — {{ rotation.activeStreamer }} is live now.</p>
              <p v-else>Log in below to see when it is your turn.</p>
              <p v-if="rotation.isRunning">Stay live until <b>{{ formatTime(rotation.turnEndsAt) }}</b>.</p>
              <div class="turn-track"><i :class="{ active: rotation.activeStreamer === rotation.streamerOne }"></i><i :class="{ active: rotation.activeStreamer === rotation.streamerTwo }"></i></div>
            </article>
            <article class="card streamer-login-card">
              <div class="card-header"><div><span class="kicker">STREAMER LOGIN</span><h3>This screen belongs to</h3></div><span v-if="loggedInStreamer" class="status-pill green">LOGGED IN</span></div>
              <p class="muted">Use the same name as the rotation setup. This login is saved only on this screen.</p>
              <label>Streamer name<input v-model="streamerName" placeholder="e.g. Streamer 1" @keyup.enter="loginStreamer" /></label>
              <div class="module-actions"><button v-if="!loggedInStreamer" class="button button-primary" @click="loginStreamer">Log in</button><button v-else class="button" @click="logoutStreamer">Log out</button></div>
            </article>
          </div>
        </section>
        <section class="multistream-chat card">
          <div class="card-header"><div><span class="kicker">TWITCH CHAT</span><h3>{{ config.chatChannel }}</h3></div><span class="muted">Live conversation</span></div>
          <div v-if="!isIpAddress" class="multistream-chat__frame"><iframe :src="twitchChatUrl" title="Twitch chat" allow="clipboard-write"></iframe></div>
          <div v-else class="multistream-chat__blocked"><strong>Chat embed needs a hostname.</strong><p>Open the dashboard through a hostname such as <b>mmarcade.test</b> instead of a raw IP address.</p></div>
        </section>
      </template>

      <template v-else-if="view === 'engagement'">
        <section class="section-heading"><div><p class="kicker">STREAM ANALYTICS</p><h2>Understand the room.</h2><p class="muted">Measurements continue in the backend every 15 seconds while it is running. Each broadcast has its own counters and history.</p></div><button class="button button-primary" @click="refreshEngagement">Refresh measurements</button></section>
        <div v-if="engagement.currentStreamId" class="stream-session-banner"><span class="live-label"><i></i> CURRENT STREAM</span><strong>{{ engagement.currentStreamId }}</strong><small>Previous streams are not included in these measurements.</small></div>
        <div v-else class="module-disabled-banner"><strong>No live stream detected.</strong><span>Engagement measurements will start when Twitch reports an active broadcast.</span></div>
        <section v-if="engagement.current" class="stat-grid engagement-stat-grid">
          <article><span>Live viewers</span><strong>{{ engagement.current.viewerCount }}</strong><small>Current Twitch viewers</small></article>
          <article><span>Chat messages</span><strong>{{ engagement.current.chatMessages }}</strong><small>Last 15 minutes</small></article>
          <article><span>Unique chatters</span><strong>{{ engagement.current.uniqueChatters }}</strong><small>Last 20 minutes</small></article>
          <article><span>Active chatters</span><strong>{{ engagement.current.activeChatters }}</strong><small>3+ messages in 10 minutes</small></article>
          <article><span>Casual chatters</span><strong>{{ engagement.current.casualChatters }}</strong><small>1–2 messages in 20 minutes</small></article>
          <article><span>Passive viewers</span><strong>{{ engagement.current.passiveViewers }}</strong><small>Viewers minus active and casual</small></article>
        </section>
        <section class="card engagement-chart-card">
          <div class="card-header"><div><span class="kicker">HISTORICAL VIEWERS</span><h3>Viewer trend · last 24 hours</h3></div><span class="muted">{{ engagementHistory.length }} measurements</span></div>
          <div v-if="engagementHistory.length" class="engagement-chart" aria-label="Historical viewer trend">
            <div v-for="snapshot in engagementHistory" :key="snapshot.timestamp" class="engagement-bar" :title="`${new Date(snapshot.timestamp).toLocaleString()} · ${snapshot.viewerCount} viewers`">
              <i :style="{ height: `${Math.max((snapshot.viewerCount / engagementMaxViewers) * 100, 3)}%` }"></i>
            </div>
          </div>
          <p v-else class="empty">No historical measurements have been collected yet. The backend must be running for measurements to appear.</p>
        </section>
        <section class="card engagement-table-card">
          <div class="card-header"><div><span class="kicker">LATEST MEASUREMENTS</span><h3>Engagement breakdown</h3></div></div>
          <div class="engagement-table">
            <div class="engagement-table__row engagement-table__header"><span>Time</span><span>Viewers</span><span>Chatters</span><span>Active</span><span>Casual</span><span>Passive</span><span>Active %</span></div>
            <div v-for="snapshot in engagementHistory.slice(-12).reverse()" :key="`row-${snapshot.timestamp}`" class="engagement-table__row"><span>{{ new Date(snapshot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span><span>{{ snapshot.viewerCount }}</span><span>{{ snapshot.uniqueChatters }}</span><span>{{ snapshot.activeChatters }}</span><span>{{ snapshot.casualChatters }}</span><span>{{ snapshot.passiveViewers }}</span><span>{{ snapshot.activeChattersPercentage }}%</span></div>
          </div>
        </section>
      </template>

    </main>
  </div>
</template>
