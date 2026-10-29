export interface PollChoiceInput {
  title: string
}

export interface CreatePollRequest {
  broadcaster_id: string
  title: string
  choices: PollChoiceInput[]
  duration: number
}

export interface PollSummary {
  id: string
  title: string
  status: string
  endsAt: string
  votes: number
  choices: PollChoiceSummary[]
}

export interface PollChoiceSummary {
  id?: string
  title: string
  votes: number
  percentage: number
}

export interface StreamRotation {
  activeStreamer: string
  streamerOne: string
  streamerTwo: string
  turnEndsAt: string
  durationMinutes: number
  isRunning: boolean
}

export interface SkipStatistics {
  turnNumber: number
  viewerCount: number
  count: number
  uniqueViewers: number
  percentage: number
}

export interface EngagementSnapshot {
  streamId: string
  timestamp: string
  viewerCount: number
  chatMessages: number
  uniqueChatters: number
  activeChatters: number
  casualChatters: number
  passiveViewers: number
  activeChattersPercentage: number
}

export interface EngagementResponse {
  currentStreamId: string | null
  current: EngagementSnapshot | null
  history: EngagementSnapshot[]
}