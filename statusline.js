#!/usr/bin/env node
'use strict';

/**
 * deepseek-hud — Claude Code statusline for DeepSeek API sessions.
 *
 * 渲染模式（config.json 的 mode，默认 auto）：
 *   auto       按 API 自动二选一：DeepSeek 会话自渲染基础行 + DeepSeek 行（不调用 claude-hud）；
 *              非 DeepSeek 会话交给 claude-hud。
 *   overlay    始终用 claude-hud 基础行，DeepSeek 会话再叠加 DeepSeek 行（claude-hud 缺失则自渲染）。
 *   standalone 始终自渲染，从不调用 claude-hud。
 *
 * 子命令：
 *   --refresh-balance 后台调 DeepSeek /user/balance，写入 balance-cache.json（由主流程惰性派生）。
 *
 * 零第三方依赖，仅使用 Node 内置模块。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT_DIR = __dirname;
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const BALANCE_CACHE_PATH = path.join(SCRIPT_DIR, 'balance-cache.json');
const BALANCE_LOCK_PATH = path.join(SCRIPT_DIR, 'balance-refresh.lock');
const TOKEN_CACHE_PATH = path.join(SCRIPT_DIR, 'token-cache.json');

// 余额刷新派生节流：无论上次成败，此窗口内只派生一次，避免 key 失效时每帧 spawn。
const BALANCE_REFRESH_THROTTLE_MS = 60_000;
// token 缓存最多保留的会话条目数，超过按 transcript mtime 淘汰最旧的。
const TOKEN_CACHE_MAX_ENTRIES = 50;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // 渲染模式：
  //   'auto'      （默认）按 API 自动二选一：DeepSeek 会话→自渲染基础行+DeepSeek 行（不用 claude-hud）；
  //                       非 DeepSeek 会话→交给 claude-hud。即「按 API 选插件」而非叠加。
  //   'overlay'   始终用 claude-hud 渲染基础行，DeepSeek 会话再叠加 DeepSeek 行（claude-hud 缺失则自渲染）。
  //   'standalone' 始终自渲染基础行，从不调用 claude-hud。
  mode: 'auto',
  // 自渲染基础行的元素开关（在 auto(DeepSeek)/standalone/或 claude-hud 缺失时生效）。
  base: {
    showModel: true,
    showProject: true,
    showGit: true,
    showContext: true,
    contextBarWidth: 10,
  },
  showCost: true,
  showCacheHit: true,
  showBalance: true,
  // 在余额后显示上次刷新距今的时间，如「余额 ¥48.50 (2分钟前)」。
  showBalanceAge: true,
  // 在 tok 后显示 in/out/cache 明细。
  showTokenBreakdown: false,
  // DeepSeek 计价（CNY / 1M tokens）。价格会调整，请对照官方定价页核对后更新。
  // pricing 为默认档（v4-flash，旧版 deepseek-chat/reasoner 弃用后也映射到 flash）；
  // pricingByModel 按 model.id 子串覆盖（pro 与 flash 不同价）。
  pricing: {
    cacheHitInput: 0.02,
    cacheMissInput: 1,
    output: 2,
  },
  pricingByModel: {
    'deepseek-v4-pro': { cacheHitInput: 0.025, cacheMissInput: 3, output: 6 },
    'deepseek-v4-flash': { cacheHitInput: 0.02, cacheMissInput: 1, output: 2 },
  },
  // 错峰折扣（DeepSeek 优惠时段 UTC 16:30-00:30）。默认关闭，避免算错。
  offPeakDiscount: false,
  offPeakRate: 0.5,
  // 余额缓存新鲜度（毫秒）。超过则后台刷新。
  balanceFreshnessMs: 5 * 60 * 1000,
  balanceUrl: 'https://api.deepseek.com/user/balance',
  // 手动指定 claude-hud 入口；留空则自动从 plugins/cache 定位最新版。
  hudCommand: '',
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const user = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...user,
      base: { ...DEFAULT_CONFIG.base, ...(user.base || {}) },
      pricing: { ...DEFAULT_CONFIG.pricing, ...(user.pricing || {}) },
      pricingByModel: { ...DEFAULT_CONFIG.pricingByModel, ...(user.pricingByModel || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function resolveMode(config) {
  const m = config.mode;
  if (m === 'auto' || m === 'overlay' || m === 'standalone') return m;
  return 'auto';
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function color(code, text) {
  if (process.env.NO_COLOR) return text;
  return code + text + ANSI.reset;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  return '¥' + n.toFixed(n < 1 ? 4 : 2);
}

function fmtAgo(ts) {
  const d = Date.now() - ts;
  if (!Number.isFinite(d) || d < 0) return '';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return Math.floor(d / 60_000) + '分钟前';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + '小时前';
  return Math.floor(d / 86_400_000) + '天前';
}

function getApiKey() {
  return (
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    ''
  );
}

// 原子写：写临时文件再 rename（同盘原子；libuv 在 Windows 用 MOVEFILE_REPLACE_EXISTING）。
function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 余额刷新模式
// ---------------------------------------------------------------------------

function refreshBalance(config) {
  const key = getApiKey();
  if (!key) return; // 无 key 静默退出

  let url;
  try {
    url = new URL(config.balanceUrl);
  } catch {
    return;
  }

  const req = https.request(
    {
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
      },
      timeout: 5000,
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return;
        try {
          const data = JSON.parse(body);
          const info = (data.balance_infos && data.balance_infos[0]) || {};
          const snapshot = {
            updated_at: Date.now(),
            is_available: Boolean(data.is_available),
            currency: info.currency || 'CNY',
            total_balance: info.total_balance ?? null,
            granted_balance: info.granted_balance ?? null,
            topped_up_balance: info.topped_up_balance ?? null,
          };
          writeJsonAtomic(BALANCE_CACHE_PATH, snapshot);
        } catch {
          /* 忽略解析/写入错误 */
        }
      });
    }
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

function readBalanceCache() {
  try {
    const raw = fs.readFileSync(BALANCE_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function maybeRefreshBalance(config) {
  const cache = readBalanceCache();
  const stale =
    !cache ||
    typeof cache.updated_at !== 'number' ||
    Date.now() - cache.updated_at > config.balanceFreshnessMs;
  if (!stale || !getApiKey()) return cache;

  // 节流：限制刷新派生频率，避免请求持续失败时每帧 spawn 进程，也消除首次成功前的瞬时多次派生。
  let lockAge = Infinity;
  try {
    lockAge = Date.now() - fs.statSync(BALANCE_LOCK_PATH).mtimeMs;
  } catch {
    /* 无锁文件 → lockAge=Infinity，允许刷新 */
  }
  const throttle = Math.min(config.balanceFreshnessMs, BALANCE_REFRESH_THROTTLE_MS);
  if (lockAge <= throttle) return cache;

  try {
    fs.writeFileSync(BALANCE_LOCK_PATH, String(Date.now()), { mode: 0o600 });
    const child = spawn(process.execPath, [__filename, '--refresh-balance'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* 派生失败不影响渲染 */
  }
  return cache;
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

function readStdin() {
  if (process.stdin.isTTY) return ''; // 无管道（手动调试）时不阻塞等 EOF
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// provider 识别
// ---------------------------------------------------------------------------

function isDeepSeek(stdin) {
  const id = (stdin.model && (stdin.model.id || stdin.model.display_name)) || '';
  if (/deepseek/i.test(id)) return true;
  if (/deepseek/i.test(process.env.ANTHROPIC_BASE_URL || '')) return true;
  if (/deepseek/i.test(process.env.ANTHROPIC_MODEL || '')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// transcript token 统计（带 mtime+size 缓存）
// ---------------------------------------------------------------------------

function emptyUsage() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

function readTokenCache() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function pruneTokenCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= TOKEN_CACHE_MAX_ENTRIES) return;
  keys
    .sort((a, b) => (cache[a].mtimeMs || 0) - (cache[b].mtimeMs || 0))
    .slice(0, keys.length - TOKEN_CACHE_MAX_ENTRIES)
    .forEach((k) => delete cache[k]);
}

function getSessionUsage(transcriptPath) {
  const usage = emptyUsage();
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return usage;

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return usage;
  }

  const cache = readTokenCache();
  const entry = cache[transcriptPath];
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    return entry.usage;
  }

  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return usage;
  }

  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'assistant' && e.message && e.message.usage) {
        const u = e.message.usage;
        usage.input += num(u.input_tokens);
        usage.output += num(u.output_tokens);
        usage.cacheCreation += num(u.cache_creation_input_tokens);
        usage.cacheRead += num(u.cache_read_input_tokens);
      }
    } catch {
      /* 跳过坏行 */
    }
  }

  try {
    cache[transcriptPath] = { mtimeMs: stat.mtimeMs, size: stat.size, usage };
    pruneTokenCache(cache);
    writeJsonAtomic(TOKEN_CACHE_PATH, cache);
  } catch {
    /* 缓存失败非致命 */
  }

  return usage;
}

// ---------------------------------------------------------------------------
// 花费计算
// ---------------------------------------------------------------------------

function isOffPeakNow() {
  // DeepSeek 错峰时段：UTC 16:30 - 次日 00:30
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 16 * 60 + 30 || mins < 30;
}

function pricingFor(stdin, config) {
  const id = ((stdin.model && (stdin.model.id || stdin.model.display_name)) || '').toLowerCase();
  const byModel = config.pricingByModel || {};
  for (const key of Object.keys(byModel)) {
    if (key && id.includes(key.toLowerCase())) return { ...config.pricing, ...byModel[key] };
  }
  return config.pricing;
}

function computeCost(usage, config, stdin) {
  const p = pricingFor(stdin, config);
  let rate = 1;
  if (config.offPeakDiscount && isOffPeakNow()) rate = config.offPeakRate;
  const cost =
    (usage.cacheRead * p.cacheHitInput +
      (usage.input + usage.cacheCreation) * p.cacheMissInput +
      usage.output * p.output) /
    1_000_000;
  return cost * rate;
}

// ---------------------------------------------------------------------------
// claude-hud 定位与调用
// ---------------------------------------------------------------------------

function findHudEntry(config) {
  if (config.hudCommand) return config.hudCommand;
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const cacheDir = path.join(base, 'plugins', 'cache');
  let candidates = [];
  try {
    for (const market of fs.readdirSync(cacheDir)) {
      const hudDir = path.join(cacheDir, market, 'claude-hud');
      if (!fs.existsSync(hudDir)) continue;
      for (const ver of fs.readdirSync(hudDir)) {
        const entry = path.join(hudDir, ver, 'dist', 'index.js');
        if (fs.existsSync(entry)) candidates.push({ ver, entry });
      }
    }
  } catch {
    return '';
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => a.ver.localeCompare(b.ver, undefined, { numeric: true }));
  return candidates[candidates.length - 1].entry;
}

function renderHud(config, rawStdin) {
  const entry = findHudEntry(config);
  if (!entry) return '';
  try {
    const res = spawnSync(process.execPath, [entry], {
      input: rawStdin,
      encoding: 'utf8',
      timeout: 5000,
      env: process.env,
    });
    return (res.stdout || '').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 自渲染基础行（替代 claude-hud：模型 · 项目 git · 上下文）
// ---------------------------------------------------------------------------

function getGit(cwd) {
  if (!cwd) return null;
  try {
    const b = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 1000,
    });
    if (b.status !== 0) return null;
    const branch = (b.stdout || '').trim();
    if (!branch) return null;
    let dirty = false;
    const s = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 1000,
    });
    if (s.status === 0) dirty = (s.stdout || '').trim().length > 0;
    return { branch, dirty };
  } catch {
    return null;
  }
}

function getContextPercent(stdin) {
  const cw = stdin.context_window;
  if (!cw) return null;
  const native = cw.used_percentage;
  if (typeof native === 'number' && Number.isFinite(native) && native > 0) {
    return Math.min(100, Math.max(0, Math.round(native)));
  }
  const size = cw.context_window_size;
  const u = cw.current_usage;
  if (!size || size <= 0 || !u) return null;
  const used = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  return Math.min(100, Math.round((used / size) * 100));
}

function contextBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  const c = pct >= 85 ? ANSI.red : pct >= 70 ? ANSI.yellow : ANSI.green;
  return color(c, bar) + ' ' + color(c, pct + '%');
}

function buildBaseLine(stdin, config) {
  const b = config.base;
  const parts = [];

  if (b.showModel) {
    const name =
      (stdin.model && (stdin.model.display_name || stdin.model.id)) || 'Unknown';
    parts.push(color(ANSI.cyan, '[' + name + ']'));
  }

  const cwd = (stdin.workspace && stdin.workspace.current_dir) || stdin.cwd || '';
  if (b.showProject && cwd) {
    const proj = path.basename(cwd) || cwd;
    let seg = color(ANSI.yellow, proj);
    if (b.showGit) {
      const git = getGit(cwd);
      if (git) {
        seg +=
          ' ' +
          color(ANSI.dim, 'git:(') +
          color(ANSI.cyan, git.branch) +
          (git.dirty ? color(ANSI.yellow, '*') : '') +
          color(ANSI.dim, ')');
      }
    }
    parts.push(seg);
  }

  if (b.showContext) {
    const pct = getContextPercent(stdin);
    if (pct !== null) {
      parts.push(color(ANSI.dim, 'ctx ') + contextBar(pct, b.contextBarWidth));
    }
  }

  return parts.join(color(ANSI.dim, ' · '));
}

// ---------------------------------------------------------------------------
// DeepSeek 信息行
// ---------------------------------------------------------------------------

function buildDeepSeekLine(stdin, config) {
  const usage = getSessionUsage(stdin.transcript_path);
  const total = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;

  const parts = [color(ANSI.cyan, '🐳 DeepSeek')];

  let tokStr = color(ANSI.dim, 'tok ') + fmtTokens(total);
  if (config.showTokenBreakdown) {
    const cached = usage.cacheRead + usage.cacheCreation;
    tokStr += color(
      ANSI.dim,
      ` (in ${fmtTokens(usage.input)}/out ${fmtTokens(usage.output)}/cache ${fmtTokens(cached)})`
    );
  }
  parts.push(tokStr);

  if (config.showCacheHit) {
    const denom = usage.cacheRead + usage.cacheCreation + usage.input;
    if (denom > 0) {
      const hit = Math.round((usage.cacheRead / denom) * 100);
      parts.push(color(ANSI.dim, '命中 ') + color(ANSI.green, hit + '%'));
    }
  }

  if (config.showCost) {
    const cost = computeCost(usage, config, stdin);
    let label = color(ANSI.dim, '花费 ') + fmtMoney(cost);
    if (config.offPeakDiscount && isOffPeakNow()) label += color(ANSI.dim, '(错峰)');
    parts.push(label);
  }

  if (config.showBalance) {
    const cache = maybeRefreshBalance(config);
    if (cache && cache.total_balance != null) {
      const bal = Number(cache.total_balance);
      let seg = color(ANSI.dim, '余额 ') + color(ANSI.yellow, fmtMoney(bal));
      if (config.showBalanceAge && typeof cache.updated_at === 'number') {
        const ago = fmtAgo(cache.updated_at);
        if (ago) seg += color(ANSI.dim, '(' + ago + ')');
      }
      parts.push(seg);
    } else if (!getApiKey()) {
      parts.push(color(ANSI.dim, '余额 需设置 key'));
    }
  }

  return parts.join(color(ANSI.dim, ' · '));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const config = loadConfig();

  if (process.argv.includes('--refresh-balance')) {
    refreshBalance(config);
    return;
  }

  const rawStdin = readStdin();
  let stdin = {};
  try {
    stdin = JSON.parse(rawStdin);
  } catch {
    stdin = {};
  }

  const lines = [];
  const ds = isDeepSeek(stdin);
  const mode = resolveMode(config);

  // 自渲染基础行（缺失 claude-hud 时也用它兜底）
  const selfBase = () => {
    const b = buildBaseLine(stdin, config);
    if (b) lines.push(b);
  };
  // 优先 claude-hud，缺失则自渲染
  const hudBase = () => {
    let b = renderHud(config, rawStdin);
    if (!b) b = buildBaseLine(stdin, config);
    if (b) lines.push(b);
  };

  if (mode === 'standalone') {
    selfBase();
    if (ds) lines.push(buildDeepSeekLine(stdin, config));
  } else if (mode === 'overlay') {
    hudBase();
    if (ds) lines.push(buildDeepSeekLine(stdin, config));
  } else {
    // auto：按 API 选插件
    if (ds) {
      selfBase();
      lines.push(buildDeepSeekLine(stdin, config));
    } else {
      hudBase();
    }
  }

  process.stdout.write(lines.join('\n'));
}

main();
