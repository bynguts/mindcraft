<h1 align="center">🧠 mindcraft v0.1.4 (reforged) ⛏️</h1>
<h1 align="center">
  <a href="https://trendshift.io/repositories/9163" target="_blank"><img src="https://trendshift.io/api/badge/repositories/9163" alt="kolbytn%2Fmindcraft | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</h1>

<p align="center"><b>A self-improving, hardened Minecraft AI agent</b> — forked from <a href="https://github.com/mindcraft-bots/mindcraft">mindcraft</a></p>

<p align="center">
  <a href="#-headline-features">Features</a> · 
  <a href="#getting-started">Setup</a> · 
  <a href="#configuration">Config</a> · 
  <a href="#supported-apis">APIs</a> · 
  <a href="#docker">Docker</a>
</p>

> [!Caution]
> Do not connect this bot to public servers with coding enabled. This project allows an LLM to write/execute code on your computer. The code is sandboxed via SES, but still vulnerable to injection attacks. Code writing is disabled by default — enable it by setting `allow_insecure_coding` to `true` in `settings.js`.

---

## 🔥 Headline Features

### 1. Autonomous Skill Lifecycle

The bot doesn't just execute skills — it **learns, evaluates, and self-prunes** them without human intervention.

| Capability | How it works |
|------------|-------------|
| **Learn** | New skills are saved with metadata + embedding vectors |
| **Deduplicate** | Cosine similarity (threshold `0.92`) detects near-duplicate skills and updates the existing one instead of creating clutter |
| **Self-Evaluate** | Every skill tracks its success/fail ratio across uses |
| **Auto-Prune** | Skills with < 30% success rate after 3+ uses are automatically deleted |
| **Version Control** | Every skill version is backed up to `history/` — rollback anytime with `!rollbackSkill` |
| **Security** | File reads use `O_RDONLY \| O_NOFOLLOW` to prevent path traversal and symlink attacks |

> Core: [`src/agent/learned_skills.js`](src/agent/learned_skills.js)

---

### 2. Quest Board System

A built-in task manager that gives the bot persistent, multi-step goals with priority levels (1–3).

- **`setQuest`** — register multi-step quests
- **`nextSubtask`** — mark subtask done, advance the queue
- Quest board is **injected into the system prompt** so the LLM always knows what it's working on
- Completed quests auto-prune from memory
- Quest state **persists across sessions** via `memory.json`

> Core: [`src/agent/memory_bank.js`](src/agent/memory_bank.js)

---

### 3. Connection Hardening

Battle-tested for 72+ hour sessions on Paper/Spigot servers.

| Fix | Problem it solves |
|-----|-------------------|
| Heartbeat watchdog (15s timeout) | Detects dead connections before the server does |
| Position packet throttle (50ms) | Prevents anti-cheat kicks from packet spam |
| `PartialReadError` suppression | Silences noisy scoreboard/protocol errors |
| Centralized disconnect handler | No more duplicate exit events or zombie processes |
| Spawn timeout + heartbeat cleanup | Clean shutdown on exit, no resource leaks |

> Core: [`src/utils/mcdata.js`](src/utils/mcdata.js), [`src/agent/agent.js`](src/agent/agent.js)

---

### 4. History I/O Optimization

Designed for multi-agent setups where disk I/O becomes a bottleneck.

- **Buffered async writes** — flush every 50 messages or 60 seconds
- **Auto-compression** — memory capped at 500 chars with 2-pass LLM summarization
- **Hard truncate fallback** — if LLM compression fails, hard-cut to prevent bloat
- **Overflow protection** — drops oldest 100+ messages from queue as a safety valve
- **Atomic file writes** — `.tmp` then rename, preventing corruption on crash

> Core: [`src/agent/history.js`](src/agent/history.js)

---

### 5. 8 New Bot Commands

| Command | Description |
|---------|-------------|
| `!exploreUntilFound` | Roam until target found — **threat-aware** (flees hostile mobs) |
| `!forceWalkTowards` | Unstuck blindwalk helper |
| `!mountEntity` / `!dismount` / `!saddleEntity` | Mount, ride, and saddle entities |
| `!rightClickBlock` | Generic block interact |
| `!unequip` | Remove armor from slot |
| `!rollbackSkill` | Restore a skill to its previous version from backup history |

Enhanced existing:
- **`goToGoal`** — door-opening interval + stuck detection + jump recovery with 30s timeout via `Promise.race()`

> Core: [`src/agent/library/skills.js`](src/agent/library/skills.js), [`src/agent/commands/actions.js`](src/agent/commands/actions.js)

---

### 6. MindServer Enhancements

- Global rate limiter: 5s duplicate block + 1.5s spam throttle
- Heartbeat watchdog (5s interval check)
- Discord DiscordSRV message parser
- `get-full-state` socket event for live UI
- `full_state.js` — structured bot state snapshot

> Core: [`src/mindcraft/mindserver.js`](src/mindcraft/mindserver.js)

---

### 7. Architecture & Config

- `constants.js` — all thresholds and timeouts centralized
- Prompter: string cache (30s TTL) for `$STATS` etc.
- Prompter: `relevant_skills` injected into `$COMMAND_DOCS`
- `!help` command lists all available commands
- `.env`-based secrets instead of `keys.json`
- SES-safe `protodef` patch — protocol compilation under strict `lockdown({ taming: 'safe' })`
- Clean, token-efficient codebase — fully self-documenting

---

## Getting Started

### Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to v1.21.11)
- [Node.js](https://nodejs.org/) (v22 LTS recommended)
- At least one API key from a [supported provider](#supported-apis)

> [!Important]
> On Windows, ensure you check `Automatically install the necessary tools` during Node.js installation.

### Install and Run

1. Clone the repository:
   ```bash
   git clone https://github.com/bynguts/mindcraft.git
   cd mindcraft
   ```

2. Copy `.env.example` to `.env` and fill in your API key(s):
   ```bash
   cp .env.example .env
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Start a Minecraft world and open it to LAN (or configure a remote server in `settings.js`).

5. Run the bot:
   ```bash
   node main.js
   ```

---

## Configuration

### Settings

All project-level settings live in [`settings.js`](settings.js). Key options:

| Setting | Default | Description |
|---------|---------|-------------|
| `minecraft_version` | `"auto"` | Minecraft version to connect to |
| `host` | `"localhost"` | Server address |
| `port` | `25565` | Server port |
| `auth` | `"offline"` | `"offline"` or `"microsoft"` |
| `mindserver_port` | `8080` | Web UI port |
| `base_profile` | `"assistant"` | Base behavior profile |
| `allow_insecure_coding` | `false` | Allow bot to write/execute code |
| `max_messages` | `20` | Context window size |

### Bot Profile

The bot is configured via a profile JSON file. The default profile is [`profiles/openrouter.json`](profiles/openrouter.json):

```json
{
    "name": "byn",
    "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free"
}
```

Change the `model` field to use any supported provider. The `name` field sets the bot's in-game username.

### Supported APIs

<details>
<summary><strong>⭐ View All Supported APIs ⭐</strong></summary>

| API | Environment Variable | Docs |
|-----|---------------------|------|
| OpenAI | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) |
| Google Gemini | `GEMINI_API_KEY` | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) |
| Anthropic | `ANTHROPIC_API_KEY` | [docs](https://docs.anthropic.com/claude/docs/models-overview) |
| xAI | `XAI_API_KEY` | [docs](https://docs.x.ai/docs) |
| DeepSeek | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) |
| Ollama (local) | n/a | [docs](https://ollama.com/library) |
| Qwen | `QWEN_API_KEY` | [docs](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api) |
| Mistral | `MISTRAL_API_KEY` | [docs](https://docs.mistral.ai/getting-started/models/models_overview/) |
| Replicate | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| Groq | `GROQCLOUD_API_KEY` | [docs](https://console.groq.com/docs/models) |
| HuggingFace | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| Novita | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api) |
| OpenRouter | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) |
| GLHF | `GHLF_API_KEY` | [docs](https://glhf.chat/user-settings/api) |
| Hyperbolic | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| Cerebras | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) |
| Mercury | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |
| vLLM (local) | n/a | — |

</details>

### Model Specification

Models can be specified as a simple string or a detailed object:

```json
"model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free"
```

Or with full control:

```json
"model": {
  "api": "openrouter",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
}
```

You can also set separate models for different tasks:

| Field | Purpose |
|-------|---------|
| `model` | Chat (default for all) |
| `code_model` | Code generation via `newAction` |
| `vision_model` | Screenshot interpretation |
| `embedding` | Example selection |
| `speak_model` | Voice synthesis (`"openai/tts-1/echo"`) |

---

## Online Servers

To connect to an online server, you need a Microsoft/Minecraft account:

```javascript
"host": "your.server.ip",
"port": 25565,
"auth": "microsoft",
```

> [!Important]
> The bot's `name` in the profile JSON must exactly match the Minecraft account name.

---

## Docker

```bash
docker-compose up --build
```

When running in Docker, use `host.docker.internal` instead of `localhost` in `settings.js` to connect to a local Minecraft server. The `.env` file is automatically mounted read-only into the container.

---

## Patches

This fork uses [`patch-package`](https://github.com/ds300/patch-package) to apply fixes to dependencies. Patches are stored in `patches/` and applied automatically during `npm install`.

| Package | Fix |
|---------|-----|
| `protodef` | SES-compatible `new Function()` compilation + suppressed partial read logging |
| `minecraft-data` | Version compatibility |
| `mineflayer` | Stability patches |
| `mineflayer-pathfinder` | Navigation fixes |
| `mineflayer-pvp` | Combat fixes |
| `prismarine-viewer` | Viewer compatibility |

```bash
npx patch-package <package-name>  # create a new patch
```

---

## Credits

Forked from [mindcraft](https://github.com/mindcraft-bots/mindcraft) by [@kolbytn](https://github.com/kolbytn), [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), and the Mindcraft team.

Original paper: [Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning](https://arxiv.org/abs/2504.17950)
