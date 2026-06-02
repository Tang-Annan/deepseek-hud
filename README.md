# deepseek-hud

> 在用 DeepSeek API 接入 Claude Code 时，在 statusline 底部显示**本会话 tokens、缓存命中率、花费（¥）、账户余额**。
>
> 三种模式（`config.json` 的 `mode`）：
> - **`auto`（默认）按当前 API 自动二选一**：DeepSeek 会话用本插件（自渲染模型/项目/git/上下文 + DeepSeek 行，**不调用 claude-hud**）；Claude 会话交给 [claude-hud](https://github.com/jarrodwatts/claude-hud)。
> - **`overlay`** 叠加：始终用 claude-hud 基础行，DeepSeek 会话再追加 DeepSeek 行。
> - **`standalone`** 独立：始终自渲染，从不调用 claude-hud（可不安装它）。

[English](./README.en.md)

---

## 效果

**`auto`（默认）— DeepSeek 会话：本插件自渲染，不调用 claude-hud**
```
[DeepSeek V4 Pro] · my-project git:(main*) · ctx █████░░░░░ 45%
🐳 DeepSeek · tok 1.24M · 命中 78% · 花费 ¥0.42 · 余额 ¥48.50(2分钟前)
```

**`auto`（默认）— Claude 会话：自动切到 claude-hud，无 DeepSeek 行**
```
[Opus 4.8] │ my-project git:(main*)
上下文 █████░░░░░ 45% │ 使用率 ██░░░░░░░░ 25%（1小时30分 / 5小时）
```

**`overlay` — DeepSeek 会话叠加：claude-hud 基础行 + DeepSeek 行**
```
<claude-hud 原本的一行/多行：模型、上下文、git…>
🐳 DeepSeek · tok 1.24M · 命中 78% · 花费 ¥0.42 · 余额 ¥48.50(2分钟前)
```

`standalone` 模式与 `auto` 的 DeepSeek 会话显示一致，区别只是非 DeepSeek 会话也强制自渲染、从不调用 claude-hud。

DeepSeek 行各字段：
- **tok**：本会话累计 tokens（input + output + cache 创建 + cache 读取）。
- **命中**：prompt cache 命中率 = `cache_read /(cache_read + cache_creation + input)`，分母为 0 时自动隐藏。
- **花费**：按本地 DeepSeek 计价表估算的本会话花费（人民币）。
- **余额**：DeepSeek 账户余额，后台异步刷新、**不阻塞渲染**；括号内为上次刷新距今时间（`showBalanceAge`）。

自渲染基础行各字段：模型徽章、项目目录名 + git 分支（`*`=有未提交改动）、上下文进度条（绿/黄/红按用量）。

---

## 工作原理

```
Claude Code ──stdin(JSON)──► statusline.js
                               1. 读 stdin
                               2. 识别是不是 DeepSeek（model.id / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL）
                               3. 基础行（按 mode 决定）：
                                    · auto       → DeepSeek 会话自渲染；非 DeepSeek 会话调用 claude-hud
                                    · overlay    → 总是调用 claude-hud（缺失则自渲染）
                                    · standalone → 总是自渲染，不调用 claude-hud
                               4. 若是 DeepSeek，追加一行：
                                    · tokens / 命中率：解析 transcript JSONL 的 message.usage 累加
                                    · 花费：本地计价表
                                    · 余额：读 balance-cache.json；过期则后台派生
                                            `node statusline.js --refresh-balance`
```

- **零第三方依赖**，仅用 Node 内置模块；**不强依赖 claude-hud**（软依赖：装了就叠加，没装就自渲染）。
- statusline 渲染频繁，所以：transcript 解析按 `mtime+size` 缓存；余额走后台进程，主流程永不等待网络。
- 独立模式的 git 段在 cwd 跑 `git`（1s 超时、失败静默），非 git 仓库时自动省略。

---

## 基础层：claude-hud 界面与使用说明

deepseek-hud 渲染的「上面那一/几行」全部来自 [claude-hud](https://github.com/jarrodwatts/claude-hud)。这里摘录它的界面与常用配置，方便你看懂整条 statusline；完整选项以上游 README 为准。

### 它显示什么

| 内容 | 含义 |
|---|---|
| **模型徽章** `[Opus]` | 当前模型；正面识别到路由提供商时显示 `Bedrock` / `Vertex` |
| **项目路径 + git** `my-project git:(main*)` | 当前项目（可配 1–3 级目录）与分支，`*` 表示有未提交改动 |
| **上下文进度条** `█████░░░░░ 45%` | 上下文窗口用量，绿 → 黄 → 红 |
| **使用率** `██░░ 25%（1小时30分 / 5小时）` | Claude 订阅用户的额度消耗（API/DeepSeek 用户无此行） |

默认两行布局：

```
[Opus] │ my-project git:(main*)
上下文 █████░░░░░ 45% │ 使用率 ██░░░░░░░░ 25%（1小时30分 / 5小时）
```

可选行（默认隐藏，需启用）：

```
◐ Edit: auth.ts | ✓ Read ×3 | ✓ Grep ×2     ← 工具活动
◐ explore [haiku]: 查找认证代码（2分15秒）    ← Agent 状态
▸ 修复认证漏洞（2/5）                          ← 待办进度
```

### 配置 claude-hud

```
/claude-hud:configure      # 引导式：预设、语言、常用开关，保存前可预览
```

预设：**完整 / 核心 / 极简**。选完可再单独开关每个元素。

常用项（写在 `~/.claude/plugins/claude-hud/config.json`，与本插件的 `config.json` 是两个不同文件）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `language` | `en` | 设 `zh` 启用中文标签 |
| `lineLayout` | `expanded` | `compact` 可压成单行 |
| `pathLevels` | `1` | 项目路径显示的目录层级 1–3 |
| `display.contextValue` | `percent` | 改 `tokens` / `remaining` / `both` 切换上下文显示格式 |
| `display.showTools` / `showAgents` / `showTodos` | `false` | 启用工具/Agent/待办行 |
| `display.showCost` | `false` | claude-hud 自带的费用（基于 Claude 计价，**对 DeepSeek 不准**，故用本插件的花费行代替即可） |
| `colors.*` | — | 支持颜色名 / 256 色数字 / `#rrggbb` |

> 注意：claude-hud 原生的 `display.showCost` 用的是 Claude/Anthropic 计价，不适用于 DeepSeek。DeepSeek 的花费请看本插件追加的 `🐳 DeepSeek` 行（按 DeepSeek 计价表估算），无需开 claude-hud 的费用。

claude-hud 运行环境：Claude Code v1.0.80+；macOS/Linux 需 Node 18+ 或 Bun，Windows 需 Node 18+。更多选项与排错见 [claude-hud 官方 README](https://github.com/jarrodwatts/claude-hud)。

---

## 前置：把 DeepSeek 接入 Claude Code

启动 Claude Code 前设置环境变量（DeepSeek 提供 Anthropic 兼容端点）：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<你的 DeepSeek API Key>
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]        # 主力模型；实惠可选 deepseek-v4-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
```

Windows PowerShell：
```powershell
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = "<你的 DeepSeek API Key>"
$env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash[1m]"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-flash[1m]"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]"
```

> 余额查询会**复用** `ANTHROPIC_AUTH_TOKEN`（找不到再依次试 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`），无需额外配置 key。

**claude-hud 是可选的**（取决于 `mode`）：
- **默认 `auto`**：DeepSeek 会话只用本插件（自渲染），不需要 claude-hud；但如果你也会开 **Claude 会话**且希望那时有 HUD，则建议装 claude-hud（`/plugin install claude-hud`，用 `/claude-hud:setup` 验证）——auto 模式会在 Claude 会话自动切到它。
- 想在 DeepSeek 会话也叠加 claude-hud 的工具/Agent/待办等丰富信息 → 设 `"mode": "overlay"` 并装 claude-hud。
- 完全不想装 claude-hud → 设 `"mode": "standalone"`。

---

## 安装

### 方式 A：marketplace（推荐，便于复用/更新）

```
/plugin marketplace add <你的 GitHub 用户名>/deepseek-hud
/plugin install deepseek-hud
/deepseek-hud:setup
```

### 方式 B：手动 clone

```bash
git clone https://github.com/<你>/deepseek-hud.git
```
然后在 Claude Code 里运行 `/deepseek-hud:setup`（命令会让你提供仓库内 `statusline.js` 的路径），
或手动改 `~/.claude/settings.json` 的 `statusLine.command`（见下）。

### 手动接线（不想用 /setup）

把 statusLine 命令里原本指向 claude-hud 的 `exec node …/claude-hud/…/dist/index.js`
改成指向本仓库的 `statusline.js`，保留前面计算 `COLUMNS` 的部分。例如 win32 + Git Bash：

```json
{
  "statusLine": {
    "type": "command",
    "command": "cols=$(stty size </dev/tty 2>/dev/null | awk '{print $2}'); export COLUMNS=$(( ${cols:-120} > 4 ? ${cols:-120} - 4 : 1 )); exec \"/d/Program Files/nodejs/node\" \"/d/Desktop/api_monitor/statusline.js\""
  }
}
```

deepseek-hud 会在内部自动定位并调用 claude-hud，无需在命令里再写 claude-hud 路径。

改完 **重启 Claude Code**。

---

## 配置

所有字段都有内置默认值。要改就把 `config.example.json` 复制为同目录下的 `config.json`，只保留想覆盖的项。

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto`=按 API 自动选插件；`overlay`=始终叠加 claude-hud；`standalone`=始终自渲染 |
| `base.showModel` / `showProject` / `showGit` / `showContext` | `true` | 自渲染基础行的各元素开关 |
| `base.contextBarWidth` | `10` | 上下文进度条字符宽度 |
| `showCost` | `true` | 是否显示花费（¥） |
| `showCacheHit` | `true` | 是否显示缓存命中率（分母为 0 时自动隐藏） |
| `showBalance` | `true` | 是否显示余额 |
| `showBalanceAge` | `true` | 在余额后显示上次刷新距今时间，如 `(2分钟前)` |
| `showTokenBreakdown` | `false` | 在 tok 后显示 `(in .../out .../cache ...)` 明细 |
| `pricing.cacheHitInput` | `0.02` | 缓存命中输入价（CNY / 1M tokens，默认档=v4-flash） |
| `pricing.cacheMissInput` | `1` | 缓存未命中输入价（CNY / 1M tokens） |
| `pricing.output` | `2` | 输出价（CNY / 1M tokens） |
| `pricingByModel` | `{deepseek-v4-pro: …, deepseek-v4-flash: …}` | 按 `model.id` 子串覆盖计价；未匹配则用 `pricing`。**pro 与 flash 单价不同，请对照官网核对** |
| `offPeakDiscount` | `false` | 错峰折扣开关（当前 DeepSeek 定价已无错峰优惠，保留仅为向前兼容） |
| `offPeakRate` | `0.5` | 错峰时段花费折算系数（已无实际作用） |
| `balanceFreshnessMs` | `300000` | 余额缓存新鲜度（毫秒），超过则后台刷新 |
| `balanceUrl` | DeepSeek 官方 | 余额接口地址，用第三方代理时按需改 |
| `hudCommand` | `""` | 手动指定 claude-hud 的 `dist/index.js`，留空自动定位 |

> ⚠️ **计价表会过时**：DeepSeek 价格调整较频繁，默认值仅供参考。请对照
> [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 核对后更新 `pricing`。

---

## 排错

| 现象 | 原因 / 对策 |
|---|---|
| 完全没有 statusline | statusLine 命令路径错或 node 没找到。跑 `/deepseek-hud:setup` 重新接线；改完要**重启** Claude Code。 |
| 没有基础行（模型/上下文/git） | `overlay` 模式下 claude-hud 没装好。要么 `/claude-hud:setup` 修好 claude-hud，要么改用 `"mode": "auto"` 或 `"standalone"` 让本插件自渲染。 |
| 余额没有「(N分钟前)」 | `showBalanceAge` 被设为 false，或缓存里无 `updated_at`（删掉 `balance-cache.json` 让它重刷）。 |
| 没有 `🐳 DeepSeek` 行 | 当前会话没被识别为 DeepSeek。确认启动时设了 `ANTHROPIC_BASE_URL`（含 deepseek）或 `ANTHROPIC_MODEL=deepseek-v4-*`。 |
| 余额显示「需设置 key」 | 启动 Claude Code 的 shell 里没有 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY`。 |
| 余额一直空白 | 首次需等后台刷新一轮（约几秒）；或 key 无效 / 网络/代理拦截。手动 `node statusline.js --refresh-balance` 看是否生成 `balance-cache.json`。 |
| 命中率不显示 | 该 DeepSeek 端点未回填 `cache_read_input_tokens`（命中率分母为 0 时自动隐藏，属正常降级）。 |
| 花费数字不对 | 计价表过时，更新 `config.json` 的 `pricing`；如使用错峰，确认 `offPeakDiscount` 与时段。 |

调试单条命令：
```bash
echo '{"model":{"id":"deepseek-v4-pro[1m]"},"transcript_path":"<某条真实会话 jsonl>"}' | node statusline.js
node statusline.js --refresh-balance   # 单独测余额刷新
```

---

## 隐私

- 余额与 token 缓存写在仓库目录下的 `balance-cache.json` / `token-cache.json`（权限 0600），已被 `.gitignore` 忽略。
- API key 只从环境变量读取，不写盘、不进任何缓存文件。

## License

MIT
