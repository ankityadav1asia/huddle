# Huddle: an AI co-host for live watch-alongs

A mobile prototype built for the Dream11 FDE intern assignment: *build one AI-powered artifact that solves a real problem fans face during a live match.*

## The fan problem

Dream11 has pivoted to a free, second-screen sports app. Paid contests stopped in August 2025 after the real-money gaming ban. In December 2025 the app relaunched around creator-led watch-alongs with chat and polls, and in August 2026 it announced an AI-first platform. Its stated goal is to fix *lonely match viewing*.

The room is the product now, and live chat during a cricket match fails in one of two ways:

- **Chaos.** A creator stream crossed 1 lakh views in 15 minutes. At that size the chat during a wicket or a bowling change is an unreadable firehose of Hinglish and emoji.
- **Silence.** A small room goes quiet between overs, and a fan watching alone has nobody to react with.

There's a third constraint that the press keeps raising about the pivot: fans may not split their attention between the TV and the phone. Anything we add has to work **in a one-second glance**.

## What Huddle does

Huddle is the AI layer *inside* a watch-along room. It doesn't replace the room.

| Feature | What the fan sees |
|---|---|
| **Room pulse** | One line on how the room feels right now, with a mood bar for each fan base. *"Dube is gone. MI fans buzzing, CSK fans nervous."* |
| **Moment threads** | When 4+ messages argue about the same moment, the AI opens a thread (`#bowling-change`, `#drs-call`) and tags each message into it. You can tap in or ignore it. |
| **Smart polls** | Polls fire at the moment of debate, not on a timer. The result becomes a headline: *"71% of this room thinks the bowling change was a mistake."* |
| **Callbacks** | The AI remembers the room's verdicts. When Tilak takes a wicket right after 71% voted against bowling him, it posts the plot twist. |
| **Catch me up** | Look away for two overs and you get three bullets: what happened, what involved your players, and what the room argued about. It also triggers when you come back to the tab. |
| **Fans like you** | Matches you with fans by team, by the players in your social-contest team, and by how you voted. |
| **Ask @huddle** | Ask anything in English or Hinglish: *"@huddle CSK ko kitne chahiye?"* |

## The 90-second demo

1. Open the link and join as a CSK fan with Dhoni, Bumrah and Dube as your picks.
2. Tap **Bowling change**. Hardik gives the 16th over to part-timer Tilak Varma while Bumrah has 2 overs left.
3. The chat explodes. Within seconds `#bowling-change` appears and a poll opens. *"71% of this room thinks the bowling change was a mistake."*
4. Two balls later Tilak gets Dube, and Huddle posts the plot twist.
5. Tap **Look away for 2 overs**, then **Catch me up**.
6. Type something yourself, or ask `@huddle` a question.

## What's real and what's simulated

- **Simulated:** the match is a fictional MI v CSK chase (real players, a made-up game) replayed ball by ball, and the crowd is scripted Hinglish chat from 32 simulated fans. The app labels it as a replay.
- **Real:** every pulse line, thread, message tag, poll, callback, catch-up and @huddle answer is generated from the chat and match state as it happens. It runs on Claude when an API key is set. Without a key it runs on an offline engine (keyword clustering plus a Hinglish/emoji sentiment lexicon) that returns the same output shape, so the demo never breaks.

## How it works

```
replay + crowd ──► room (chat, ball-by-ball)
                       │  every ~9s, or ~3s after a big moment
                       ▼
               one batched AI call per room ──► pulse · mood · threads · tags · poll · callback · for-you
```

- **One call per room per tick, not one per message.** The app batches up to 80 new messages with the match state, the open threads, recent polls and the viewer's profile. It gets back a single JSON object, enforced with structured outputs. At IPL scale this is the difference between millions of calls a minute and one per room.
- **Rules detect, the model writes.** Cheap code spots a callback (for example, the bowler the room voted against just took a wicket). The model writes the line. The same split would run in production: a lightweight classifier on every message and the LLM on the room.
- **Polls hold the story.** The replay pauses briefly while a poll is open, so a result is never spoiled by the next ball.
- **Safe by default.** The API key stays on the server. Chat is treated as data, never as instructions. A public link is rate-limited, and after repeated failures the app switches to the offline engine.

## If this shipped: what I'd measure

- Thread join rate, and messages per fan per match
- Time in room, and how many fans stay through the innings break
- Poll participation, and Catch me up opens per returning fan
- Whether pulse + threads lower the share of fans who leave in the first 2 minutes of a busy room

## Run it

```bash
npm install
npm start            # http://localhost:3000, offline engine
```

To use the live AI, copy `.env.example` to `.env` and set one key:

- `OPENROUTER_API_KEY`: defaults to `google/gemini-3.5-flash-lite`, roughly $0.05 to $0.10 for a full demo run. Set `OPENROUTER_MODEL` to try any other model.
- `ANTHROPIC_API_KEY`: calls Claude directly through the Anthropic SDK.
- `GEMINI_API_KEY`: calls Gemini directly, defaulting to `gemini-3.5-flash-lite`. This is the setup the demo was tested with: about 3 to 4 seconds per room update.

Then run `npm start` again. Add `?offline` to the URL to force the offline engine.

## Deploy (Vercel)

1. Push this folder to GitHub and import it in Vercel. `vercel.json` already serves `public/` and deploys `api/ai.js` as a function.
2. Add `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`) under Project → Settings → Environment Variables, and set a credit limit on the key.
3. Redeploy and share the URL.

## Files

- `public/src/app.js`: room UI, replay runner, AI ticks, polls, sheets
- `public/src/data.js`: match script, Hinglish crowd lines, simulated fans
- `public/src/local-ai.js`: offline engine
- `lib/prompts.js`: prompts and JSON schemas for `tick`, `catchup`, `ask`
- `api/ai.js`: serverless endpoint (OpenRouter, Claude via the Anthropic SDK, or Gemini)
- `server.js`: local dev server

Team names and logos belong to their franchises. They are used here only to make the prototype feel real.
