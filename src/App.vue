<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { TwitchApiClient } from './services/twitchApi'
import type { PollSummary, StreamRotation } from './types/twitch'

type View = 'overview' | 'moderation' | 'rotation' | 'chat'

const defaultBackendUrl = 'http://localhost:5071'
const configuredApiBaseUrl = import.meta.env.VITE_TWITCH_API_BASE_URL ?? defaultBackendUrl

function useLocalHttpBackend(url: string) {
  return url
    .replace('https://localhost:7028', 'http://localhost:5071')
    .replace('https://127.0.0.1:7028', 'http://127.0.0.1:5071')
}

const config = reactive({
  apiBaseUrl: useLocalHttpBackend(configuredApiBaseUrl),
  broadcasterId: '876318030',
  chatChannel: 'mmarcadebnl',
})
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
let pollRefreshTimer: number | undefined
let rotationRefreshTimer: number | undefined
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
const twitchChatUrl = computed(() => {
  const channel = encodeURIComponent(config.chatChannel.trim().replace(/^#/, '').toLowerCase())
  const parent = encodeURIComponent(typeof window === 'undefined' ? 'localhost' : window.location.hostname)
  return `https://www.twitch.tv/embed/${channel}/chat?parent=${parent}&darkpopout`
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

function normalizePoll(raw: unknown): PollSummary {
  const choices = (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).choices)
    ? (raw as Record<string, unknown>).choices
    : []) as unknown[]
  const total = choices.reduce<number>((sum, choice) => sum + number(choice, ['votes', 'totalVotes'], 0), 0)
  return {
    id: record(raw, ['id', 'pollId'], crypto.randomUUID()),
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
    await nextTick()
    dashboardStateInitialized = true
    addNotice('Dashboard refreshed.')
  } catch (error) {
    addNotice(error instanceof Error ? error.message : 'Could not load dashboard data.')
  } finally {
    isBusy.value = false
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
  modules.streamSwitchEnabled = localStorage.getItem('mm-arcade-stream-switch-enabled') !== 'false'
  void loadData()
  pollRefreshTimer = window.setInterval(() => {
    void refreshPolls()
  }, 5000)
  rotationRefreshTimer = window.setInterval(() => {
    void refreshRotation()
  }, 2000)
})
onBeforeUnmount(() => {
  if (pollRefreshTimer !== undefined) {
    window.clearInterval(pollRefreshTimer)
  }
  if (rotationRefreshTimer !== undefined) {
    window.clearInterval(rotationRefreshTimer)
  }
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">M</span><div><strong>Arcade Control</strong><small>STREAM OPERATIONS</small></div></div>
      <nav class="nav">
        <button v-for="item in [
          ['overview', 'Overview', '⌂'],
          ['moderation', 'Moderation', '◈'],
          ['rotation', 'Stream switch', '↻'],
          ['chat', 'Live chat', '☷'],
        ]" :key="item[0]" :class="{ active: view === item[0] }" @click="view = item[0] as View"><span>{{ item[2] }}</span>{{ item[1] }}</button>
      </nav>
    </aside>

    <main class="main">
      <header class="topbar"><div><p class="kicker">MEDIA MARKT ARCADE</p><h1>{{ view === 'overview' ? 'Good evening, operator.' : view === 'moderation' ? 'Moderation desk' : view === 'rotation' ? 'Stream rotation' : 'Live chat' }}</h1></div><div class="topbar-actions"><input v-model="config.broadcasterId" placeholder="Broadcaster ID" /><button class="button button-primary" :disabled="isBusy" @click="loadData">Refresh</button></div></header>
      <div v-if="announcement" class="announcement" :class="`announcement--${announcement.type}`" role="status">
        <strong>{{ announcement.type === 'rotation' ? 'STREAM SWITCH' : 'POLL RESULT' }}</strong>
        <span>{{ announcement.message }}</span>
        <button type="button" aria-label="Dismiss notification" @click="announcement = null">×</button>
      </div>
      <div v-if="notice" class="notice">{{ notice }}</div>

      <template v-if="view === 'overview'">
        <section class="section-heading overview-heading"><div><p class="kicker">STREAM WORKSPACE</p><h2>Choose the tools for this stream.</h2><p class="muted">Keep the control room focused on the modules you actually need today.</p></div><div class="hero-date">{{ new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) }}</div></section>
        <section class="module-grid">
          <article class="module-card module-card--featured"><div class="module-icon">◈</div><div><span class="kicker">MODERATION</span><h3>Polls</h3><p>Create polls and see live results.</p></div><button class="button button-primary" @click="view = 'moderation'">Open moderation</button></article>
          <article class="module-card" :class="{ 'module-card--disabled': !modules.streamSwitchEnabled }"><div class="module-card__top"><div class="module-icon">↻</div><span class="status-pill" :class="{ green: modules.streamSwitchEnabled }">{{ modules.streamSwitchEnabled ? 'ENABLED' : 'DISABLED' }}</span></div><span class="kicker">OPTIONAL MODULE</span><h3>Stream Switch</h3><p>Let two streamers share a turn and notify everyone when the active streamer changes.</p><div class="module-actions"><button class="button" @click="toggleStreamSwitch">{{ modules.streamSwitchEnabled ? 'Disable for this stream' : 'Enable for this stream' }}</button><button class="text-button" :disabled="!modules.streamSwitchEnabled" @click="view = 'rotation'">Open module →</button></div></article>
          <article class="module-card"><div class="module-card__top"><div class="module-icon">☷</div><span class="status-pill green">READY</span></div><span class="kicker">VIEWER FEED</span><h3>Live chat</h3><p>Use Twitch’s native chat directly in the dashboard.</p><button class="button" @click="view = 'chat'">Open live chat</button></article>
        </section>
        <section class="overview-grid"><article class="card"><div class="card-header"><div><span class="kicker">STREAM SNAPSHOT</span><h3>Right now</h3></div><button class="text-button" :disabled="isBusy" @click="loadData">Refresh</button></div><div class="snapshot-list"><div><span>Poll</span><strong>{{ activePoll ? 'Running' : 'No active poll' }}</strong><small>{{ activePoll?.title || 'Ready for the next audience question' }}</small></div><div><span>Chat</span><strong>Twitch embed ready</strong><small>Open Live chat to view the channel conversation</small></div><div><span>Stream Switch</span><strong>{{ modules.streamSwitchEnabled ? rotation.activeStreamer : 'Module disabled' }}</strong><small>{{ modules.streamSwitchEnabled ? 'Shared state is synced between clients' : 'Enable it from the module card above' }}</small></div></div></article><article class="card"><div class="card-header"><div><span class="kicker">NEXT ACTIONS</span><h3>Quick start</h3></div></div><div class="quick-actions"><button @click="view = 'moderation'">Start a poll <span>→</span></button><button @click="view = 'chat'">Open live chat <span>→</span></button><button :disabled="!modules.streamSwitchEnabled" @click="view = 'rotation'">Configure Stream Switch <span>→</span></button></div></article></section>
      </template>

      <template v-else-if="view === 'moderation'">
        <section class="section-heading"><div><p class="kicker">MODERATION</p><h2>Make the call quickly.</h2></div><span class="muted">Polls are applied to Twitch immediately.</span></section>
        <section class="content-grid"><article class="card"><div class="card-header"><div><span class="kicker">NEW POLL</span><h3>Ask the audience</h3></div></div><label>Question<input v-model="pollForm.title" placeholder="Which streamer should be on screen?" /></label><label>Choices <small>one per line</small><textarea v-model="pollForm.choices" rows="4"></textarea></label><label>Duration in seconds<input v-model.number="pollForm.duration" type="number" min="15" max="1800" /></label><button class="button button-primary full" :disabled="isBusy" @click="createPoll">Start poll</button></article><article class="card"><div class="card-header"><div><span class="kicker">CURRENT POLL</span><h3>{{ activePoll?.title || 'No active poll' }}</h3></div><button v-if="activePoll" class="button button-danger" @click="endPoll">End poll</button></div><div v-if="activePoll" class="result-list"><div v-for="choice in activePoll.choices" :key="choice.title" class="result-row"><div class="result-label"><span>{{ choice.title }}</span><strong>{{ choice.votes }} <small>{{ choice.percentage }}%</small></strong></div><div class="bar"><i :style="{ width: `${choice.percentage}%` }"></i></div></div></div><div v-else-if="winners.length" class="winner">Winner<span v-for="winner in winners" :key="winner.title"><strong>{{ winner.title }}</strong></span></div><div v-else class="empty">Your latest poll results will appear here.</div></article></section>
      </template>

      <template v-else-if="view === 'rotation'">
        <section class="section-heading"><div><p class="kicker">OPTIONAL MODULE · STREAM SWITCH</p><h2>Everyone sees the same turn.</h2><p class="muted">Enable this module only when two streamers are sharing a stream.</p></div><div class="module-actions"><button class="button" @click="toggleStreamSwitch">{{ modules.streamSwitchEnabled ? 'Disable module' : 'Enable module' }}</button><button class="button button-primary" :disabled="!modules.streamSwitchEnabled" @click="advanceRotation">Switch streamer</button></div></section>
        <div v-if="!modules.streamSwitchEnabled" class="module-disabled-banner"><strong>Stream Switch is disabled.</strong><span>Enable the module to configure turns and notify the streamers.</span></div>
        <section class="rotation-layout"><article class="rotation-card"><span class="live-label"><i></i> CURRENTLY ON</span><strong>{{ rotation.activeStreamer }}</strong><p v-if="rotation.isRunning">Stay live until <b>{{ formatTime(rotation.turnEndsAt) }}</b>.</p><p v-else>Rotation is paused. Start it when both streamers are ready.</p><div class="turn-track"><i :class="{ active: rotation.activeStreamer === rotation.streamerOne }"></i><i :class="{ active: rotation.activeStreamer === rotation.streamerTwo }"></i></div></article><article class="card"><div class="card-header"><div><span class="kicker">ROTATION SETTINGS</span><h3>Two-streamer setup</h3></div></div><label>Streamer one<input v-model="rotationForm.streamerOne" :placeholder="rotation.streamerOne" /></label><label>Streamer two<input v-model="rotationForm.streamerTwo" :placeholder="rotation.streamerTwo" /></label><label>Minutes per turn<input v-model.number="rotationForm.durationMinutes" type="number" min="1" max="240" /></label><button class="button button-primary full" @click="saveRotation">Save shared state</button></article></section>
        <section class="card streamer-presence"><div><span class="kicker">STREAMER VIEW</span><h3>What the streamers should know</h3></div><div class="presence-grid"><div :class="{ selected: rotation.activeStreamer === rotation.streamerOne }"><span class="presence-dot"></span><strong>{{ rotation.streamerOne }}</strong><small>{{ rotation.activeStreamer === rotation.streamerOne ? 'You are on stream now' : 'Stand by' }}</small></div><div :class="{ selected: rotation.activeStreamer === rotation.streamerTwo }"><span class="presence-dot"></span><strong>{{ rotation.streamerTwo }}</strong><small>{{ rotation.activeStreamer === rotation.streamerTwo ? 'You are on stream now' : 'Stand by' }}</small></div></div></section>
      </template>

      <template v-else>
        <section class="section-heading"><div><p class="kicker">LIVE CHAT</p><h2>Keep the room readable.</h2><p class="muted">View the channel conversation through Twitch’s native chat.</p></div></section>
        <section class="chat-embed-card card">
          <div class="chat-embed-toolbar"><label>Channel<input v-model="config.chatChannel" placeholder="mmarcadebnl" /></label><span class="muted">Official Twitch chat embed</span></div>
          <div class="active-streamer-banner">
            <div><span class="kicker">ON STREAM NOW</span><strong>{{ rotation.activeStreamer }}</strong></div>
            <span class="shared-state">Shared live state</span>
          </div>
          <iframe class="chat-embed" :src="twitchChatUrl" title="Twitch chat" allow="clipboard-write"></iframe>
        </section>
      </template>
    </main>
  </div>
</template>
