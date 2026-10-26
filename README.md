# Vue 3 + TypeScript + Vite

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about the recommended Project Setup and IDE Support in the [Vue Docs TypeScript Guide](https://vuejs.org/guide/typescript/overview.html#project-setup).

## Streamer screens

Open **Stream switch** on each streamer screen and log in with the matching rotation name. The active streamer sees a prominent **YOUR TURN** state, while the other screen shows who is currently live. The rotation view also includes the Twitch chat so streamers do not need a second dashboard.

The Stream Switch page also shows manual game-vote decision support. The backend keeps separate counters for exact `!zelda` and `!stellarblade` messages, including unique viewers and percentages. The **Reset votes** button clears both counters without changing the active streamer. Counters also reset when the active streamer changes, and they never switch streamers automatically.

The **Engagement** page shows live viewers, chat messages, unique chatters, active chatters, casual chatters, passive viewers, and active chatter percentage. The backend records a snapshot every 15 seconds while it is running and persists up to 30 days of history in `App_Data/engagement-history.json`. Measurements are grouped by Twitch broadcast ID, so a new stream starts with fresh counters and the page never mixes data from previous streams. Active chatters are viewers with at least 3 messages in 10 minutes; casual chatters have 1–2 messages in 20 minutes; passive viewers are live viewers minus active and casual chatters.
