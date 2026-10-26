import type { CreatePollRequest, EngagementResponse, SkipStatistics, StreamRotation } from '../types/twitch'

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | object
}

type RotationResponse = {
  streamers?: string[]
  currentStreamer?: string
  turnNumber?: number
  updatedAt?: string
}

function toBaseUrl(value: string) {
  return value.endsWith('/') ? value : `${value}/`
}

function buildUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ''), toBaseUrl(baseUrl))
}

function normalizeRotation(value: RotationResponse): StreamRotation {
  const streamers = value.streamers ?? []
  const streamerOne = streamers[0] ?? 'Streamer 1'
  const streamerTwo = streamers[1] ?? 'Streamer 2'

  return {
    activeStreamer: value.currentStreamer ?? streamerOne,
    streamerOne,
    streamerTwo,
    turnEndsAt: '',
    durationMinutes: 30,
    isRunning: Boolean(value.currentStreamer),
  }
}

async function readErrorMessage(response: Response) {
  const body = await response.text()

  if (body.trim().length === 0) {
    return response.statusText || 'Request failed'
  }

  try {
    const payload: unknown = JSON.parse(body)

    if (typeof payload === 'string') {
      return payload
    }

    if (payload && typeof payload === 'object') {
      const candidate = payload as Record<string, unknown>
      const message = candidate.message ?? candidate.error ?? candidate.detail
      if (typeof message === 'string' && message.trim().length > 0) {
        return message
      }
    }
  } catch {
    return body
  }

  return response.statusText || 'Request failed'
}

export class TwitchApiClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await fetch(buildUrl(this.baseUrl, path), {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      ...options,
      body:
        options.body && typeof options.body === 'object' && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  getChannelInfo(broadcasterId: string) {
    return this.request<unknown>(`api/twitch/channels/${encodeURIComponent(broadcasterId)}`)
  }

  getUserInfo(loginUserName: string) {
    return this.request<unknown>(`api/twitch/users/${encodeURIComponent(loginUserName)}`)
  }

  getPolls(broadcasterId: string, pollId?: string) {
    const url = new URL(buildUrl(this.baseUrl, 'api/twitch/polls'))
    url.searchParams.set('broadcasterId', broadcasterId)

    if (pollId) {
      url.searchParams.set('pollId', pollId)
    }

    return this.request<unknown>(url.pathname + url.search)
  }

  createPoll(request: CreatePollRequest) {
    return this.request<unknown>('api/twitch/polls', {
      method: 'POST',
      body: request as object,
    })
  }

  endPoll(request: { broadcasterId: string; pollId: string }) {
    return this.request<unknown>(`api/twitch/polls/${encodeURIComponent(request.pollId)}/end`, {
      method: 'POST',
      body: {
        broadcaster_id: request.broadcasterId,
      },
    })
  }

  getRotation() {
    return this.request<RotationResponse>('api/twitch/rotation').then(normalizeRotation)
  }

  getSkipStatistics(broadcasterId: string) {
    const url = new URL(buildUrl(this.baseUrl, 'api/twitch/skip-stats'))
    url.searchParams.set('broadcasterId', broadcasterId)
    return this.request<SkipStatistics>(url.pathname + url.search)
  }

  getEngagement(days = 30) {
    const url = new URL(buildUrl(this.baseUrl, 'api/twitch/engagement'))
    url.searchParams.set('days', String(days))
    return this.request<EngagementResponse>(url.pathname + url.search)
  }

  resetSkipStatistics() {
    return this.request<void>('api/twitch/skip-stats/reset', { method: 'POST' })
  }

  updateRotation(rotation: Partial<StreamRotation>) {
    const streamers = [rotation.streamerOne, rotation.streamerTwo].filter(
      (streamer): streamer is string => Boolean(streamer?.trim()),
    )
    return this.request<RotationResponse>('api/twitch/rotation', {
      method: 'PUT',
      body: {
        streamers,
        currentStreamer: rotation.activeStreamer,
      },
    }).then(normalizeRotation)
  }

  selectCurrentStreamer(currentStreamer: string) {
    return this.request<RotationResponse>('api/twitch/rotation/current', {
      method: 'PUT',
      body: { currentStreamer },
    }).then(normalizeRotation)
  }

  advanceRotation() {
    return this.request<RotationResponse>('api/twitch/rotation/advance', { method: 'POST' }).then(normalizeRotation)
  }
}