---
description: 把 deepseek-hud 接到 Claude Code 的 statusLine（包装 claude-hud 并追加 DeepSeek 信息行）
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

本命令把 `deepseek-hud/statusline.js` 设为 Claude Code 的 statusLine 入口。该脚本会先原样渲染
已安装的 **claude-hud**，再在自动识别为 DeepSeek 的会话上追加一行（tokens · 缓存命中率 · 花费¥ · 余额¥）。

> 前置：必须已安装并能正常工作的 **claude-hud**（deepseek-hud 是它的增强层，不是替代品）。
> 若未安装，先 `/plugin install claude-hud` 并用 `/claude-hud:setup` 确认其可用，再回来跑本命令。

## Step 1：定位 deepseek-hud 与 node

按环境上下文里的 `Platform:` 与 `Shell:` 选择分支，不要用 `uname`。

**deepseek-hud 的 statusline.js 路径**：
- 若通过 marketplace 安装：在 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/*/deepseek-hud/*/statusline.js`，取版本号最大的一个。
- 若手动 clone：就是仓库里的 `statusline.js` 绝对路径（例如 `D:\Desktop\api_monitor\statusline.js`）。

macOS/Linux 或 win32+bash：
```bash
ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/deepseek-hud/*/statusline.js 2>/dev/null | sort -V | tail -1
```
win32+PowerShell：
```powershell
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
(Get-ChildItem (Join-Path $claudeDir "plugins\cache\*\deepseek-hud\*\statusline.js") -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1).FullName
```
若都为空，请改用手动 clone 的仓库路径。

**node 绝对路径**：
- bash：`command -v node`
- PowerShell：`(Get-Command node).Source`

## Step 2：生成 statusLine 命令

命令负责导出 `COLUMNS`（claude-hud 据此计算宽度）后 exec 到 deepseek-hud。把 `{NODE}` 与 `{DSHUD}`
替换为 Step 1 检测到的绝对路径（路径含空格时保留引号）。

**macOS/Linux 或 win32 + Git Bash**：
```
cols=$(stty size </dev/tty 2>/dev/null | awk '{print $2}'); export COLUMNS=$(( ${cols:-120} > 4 ? ${cols:-120} - 4 : 1 )); exec "{NODE}" "{DSHUD}"
```

**win32 + PowerShell / cmd**：
```
powershell -Command "& {$env:COLUMNS=[Math]::Max(1,[Console]::WindowWidth-4); & '{NODE}' '{DSHUD}'}"
```

> 说明：deepseek-hud 会在内部自动定位并调用 claude-hud 的 `dist/index.js`（继承本命令导出的
> `COLUMNS` 等环境变量），所以这里不再直接指向 claude-hud。

## Step 3：测试

直接运行生成的命令并喂一段假的 stdin，确认能在几秒内输出且不报错：
```bash
echo '{"model":{"id":"deepseek-chat"},"transcript_path":""}' | <生成的命令>
```
应至少看到 claude-hud 的行 + 一行 `🐳 DeepSeek …`。报错则先排查路径，不要写入配置。

## Step 4：写入 settings.json

用 JSON 序列化（不要手工拼字符串）把下面合并进设置文件，保留其它所有字段：
- bash / win32+bash：`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`
- win32+PowerShell：`$env:CLAUDE_CONFIG_DIR` 或 `Join-Path $HOME ".claude"` 下的 `settings.json`

```json
{
  "statusLine": {
    "type": "command",
    "command": "{GENERATED_COMMAND}"
  }
}
```

写入后提示用户：

> ✅ 已写入配置。请**完全退出并重启 Claude Code**，然后在一个 DeepSeek 会话里查看底部是否出现
> claude-hud 行 + `🐳 DeepSeek` 行。原生 Claude 会话则只会显示 claude-hud 行。

## Step 5：余额与配置（可选）

- **余额**：deepseek-hud 复用接入用的环境变量 `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY`）
  调 DeepSeek `/user/balance`，后台异步刷新。若余额一直显示「需设置 key」，说明该 shell 启动 Claude Code 时
  没有这个环境变量。
- **计价/折扣/开关**：复制仓库里的 `config.example.json` 为 `config.json` 修改。计价表请对照
  DeepSeek 官方定价页核对。详见 README。
