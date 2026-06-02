# deepseek-hud

> When you drive Claude Code with the DeepSeek API, this shows **session tokens, prompt-cache hit rate, spend (¥) and account balance** in the statusline.
>
> Three modes (`mode` in `config.json`):
> - **`auto` (default) — picks the renderer by current API**: DeepSeek sessions are rendered by this plugin (self-rendered model/project/git/context + DeepSeek line, **no claude-hud**); Claude sessions are delegated to [claude-hud](https://github.com/jarrodwatts/claude-hud).
> - **`overlay`** — always render the claude-hud base line, then append the DeepSeek line on DeepSeek sessions.
> - **`standalone`** — always self-render, never call claude-hud (no need to install it).

[中文文档](./README.md)

---

## Output

**`auto` (default) — DeepSeek session: self-rendered, no claude-hud**
```
[DeepSeek V4 Pro] · my-project git:(main*) · ctx █████░░░░░ 45%
🐳 DeepSeek · tok 1.24M · 命中 78% · 花费 ¥0.42 · 余额 ¥48.50(2分钟前)
```

**`auto` (default) — Claude session: delegated to claude-hud, no DeepSeek line**
```
[Opus 4.8] │ my-project git:(main*)
Context █████░░░░░ 45% │ Usage ██░░░░░░░░ 25%
```

**`overlay` — DeepSeek session: claude-hud base + DeepSeek line**
```
<claude-hud's own line(s): model, context, git…>
🐳 DeepSeek · tok 1.24M · 命中 78% · 花费 ¥0.42 · 余额 ¥48.50(2分钟前)
```

DeepSeek line fields:
- **tok** — cumulative session tokens (input + output + cache creation + cache read). With `showTokenBreakdown` it also shows `(in …/out …/cache …)`.
- **命中 (hit)** — prompt-cache hit rate = `cache_read / (cache_read + cache_creation + input)`; auto-hidden when the denominator is 0.
- **花费 (spend)** — estimated session cost in CNY from a local pricing table (per-model via `pricingByModel`).
- **余额 (balance)** — DeepSeek account balance, refreshed in the background (never blocking render); the parenthesis shows how long ago it was refreshed (`showBalanceAge`).

Self-rendered base line: model badge, project dir + git branch (`*` = uncommitted changes), context bar (green/yellow/red by usage).

---

## How it works

```
Claude Code ──stdin(JSON)──► statusline.js
   1. read stdin
   2. detect DeepSeek (model.id / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL)
   3. base line (by mode):
        · auto       → DeepSeek session self-rendered; non-DeepSeek → claude-hud
        · overlay    → always claude-hud (self-render fallback if missing)
        · standalone → always self-render, never claude-hud
   4. if DeepSeek, append a line:
        · tokens / hit rate: sum message.usage from the transcript JSONL (cached by mtime+size)
        · spend: local pricing table
        · balance: read balance-cache.json; if stale, detached spawn
                   `node statusline.js --refresh-balance` (throttled)
```

Zero third-party dependencies (Node built-ins only). **No hard dependency on claude-hud** (soft: overlaid if present, self-rendered otherwise). Balance lives in a background process so rendering never waits on the network; refresh spawns are throttled and caches are written atomically.

---

## Prerequisite: connect DeepSeek to Claude Code

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]   # flagship; budget option: deepseek-v4-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
```

Balance lookup reuses `ANTHROPIC_AUTH_TOKEN` (falling back to `ANTHROPIC_API_KEY`, then `DEEPSEEK_API_KEY`).

**claude-hud is optional** (depends on `mode`): in the default `auto` mode, DeepSeek sessions need no claude-hud, but if you also open **Claude** sessions and want a HUD there, install claude-hud (`/plugin install claude-hud`). Use `mode: "standalone"` to never need it, or `mode: "overlay"` to also overlay it on DeepSeek sessions.

---

## Install

### A. Marketplace (recommended)
```
/plugin marketplace add <your-gh-user>/deepseek-hud
/plugin install deepseek-hud
/deepseek-hud:setup
```

### B. Manual clone
```bash
git clone https://github.com/<you>/deepseek-hud.git
```
Then run `/deepseek-hud:setup`, or point `statusLine.command` in `~/.claude/settings.json` at this repo's `statusline.js` (keep the `COLUMNS` prefix). Restart Claude Code after.

---

## Configuration

Copy `config.example.json` to `config.json` and keep only the keys you want to override.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto`=pick renderer by API; `overlay`=always overlay claude-hud; `standalone`=always self-render |
| `base.showModel` / `showProject` / `showGit` / `showContext` | `true` | toggles for the self-rendered base line |
| `base.contextBarWidth` | `10` | context bar character width |
| `showCost` | `true` | show spend (¥) |
| `showCacheHit` | `true` | show cache hit rate (auto-hidden when denominator is 0) |
| `showBalance` | `true` | show balance |
| `showBalanceAge` | `true` | show "(N ago)" after balance |
| `showTokenBreakdown` | `false` | show `(in …/out …/cache …)` after tok |
| `pricing.*` | `0.02/1/2` | default tier prices (v4-flash) in CNY / 1M tokens (cache-hit / cache-miss / output) |
| `pricingByModel` | `{deepseek-v4-pro: …, deepseek-v4-flash: …}` | per-`model.id` price overrides; **verify against the official page** |
| `offPeakDiscount` | `false` | off-peak discount (no longer applicable with current pricing; kept for compat) |
| `offPeakRate` | `0.5` | off-peak multiplier (no longer applicable) |
| `balanceFreshnessMs` | `300000` | balance cache freshness (ms) |
| `balanceUrl` | DeepSeek official | balance endpoint (change for a proxy) |
| `hudCommand` | `""` | explicit claude-hud `dist/index.js`; empty = auto-detect |

> ⚠️ Prices change. Verify `pricing` / `pricingByModel` against the [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No statusline at all | Wrong path or node not found. Run `/deepseek-hud:setup`; restart Claude Code. |
| No base line (model/context/git) | In `overlay` mode claude-hud isn't set up. Fix it via `/claude-hud:setup`, or switch to `mode: "auto"` / `"standalone"`. |
| No `🐳 DeepSeek` line | Session not detected as DeepSeek. Ensure `ANTHROPIC_BASE_URL` contains `deepseek` or `ANTHROPIC_MODEL=deepseek-v4-*`. |
| Balance shows "需设置 key" | No `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY` in the launching shell. |
| Balance always blank | Wait one background refresh; or invalid key / network. Run `node statusline.js --refresh-balance` to test. |
| No hit rate | The endpoint doesn't return `cache_read_input_tokens` (auto-hidden — graceful degradation). |
| Wrong spend | Stale pricing; update `pricing` / `pricingByModel` in `config.json`. |

## License

MIT
