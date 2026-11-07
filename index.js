/**
 * dsh-keeper · 守夜人
 *
 * 让 AI 从「响应者」变成「负责人」：
 * 事件推过来才动，是响应者；知道该是什么样、发现差多少就补，才是负责人。
 *
 * 「该做没做」不会产生任何事件——它只是让局面一点点烂下去，而烂是安静的。
 * 这个插件把「安静地烂」变成「响亮地提醒」。
 *
 * 核心：期望状态 vs 实际状态，差 = 漏掉的事，差非空就唤醒。
 */

export const name = 'dsh-keeper'

/**
 * 要用的服务都声明出来。
 * 唤醒靠 agent.steer / agent.followup —— 就是 Aurabot 在 QQ 里「思考中插话」用的同一套。
 * 不声明 inject，ctx.agents 会抛 "cannot get property xxx without inject"。
 */
export const inject = ['tools', 'agents', 'sessions', 'sessionController']

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 }

const DEFAULT_LIMITS = {
  minSeverity: 'warn',
  dedupeMs: 30 * 60 * 1000,
  maxWakesPerHour: 6,
  quietHours: null,          // { from: 2, to: 8 }
}

export function apply(ctx, config = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) }
  const checkers = new Map()
  const lastReported = new Map()
  const wakeHistory = []
  const log = []

  let timer = null
  let running = false
  let degraded = false

  function logEvent(kind, data) {
    const rec = { t: Date.now(), kind, ...data }
    log.push(rec)
    if (log.length > 500) log.shift()
    return rec
  }

  function severityOk(sev) {
    return (SEVERITY_RANK[sev] ?? 1) >= (SEVERITY_RANK[limits.minSeverity] ?? 1)
  }

  function inQuietHours() {
    const q = limits.quietHours
    if (!q) return false
    const h = new Date().getHours()
    return q.from <= q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to
  }

  function notDuplicate(key) {
    const now = Date.now()
    const prev = lastReported.get(key)
    if (prev && now - prev < limits.dedupeMs) return false
    lastReported.set(key, now)
    return true
  }

  function canWake() {
    const now = Date.now()
    while (wakeHistory.length && now - wakeHistory[0] > 3600_000) wakeHistory.shift()
    return wakeHistory.length < limits.maxWakesPerHour
  }

  function formatWakeMessage(gaps) {
    const lines = gaps.map(g => `· [${g.severity}] ${g.what}${g.hint ? ` → ${g.hint}` : ''}`)
    return `[守夜人] 发现 ${gaps.length} 件该做没做的事：\n${lines.join('\n')}`
  }

  /**
   * 找目标会话的 agent —— 这段是照着 Aurabot 的 hub.js 抄的（`resolveAgent`）。
   *
   *   const live = dsh.agents.get(sid) || dsh.agents.get('session-' + sid)
   *   if (live) return live
   *   const r = await controller().resolveAgent(sid)
   *   if (r && r.agent) return r.agent
   */
  async function resolveTargetAgent() {
    // 没配就用「最近写过东西」的那个会话
    const sid = config.targetSessionId || guessSessionId()

    // ctx.agents 没 inject 成功时会「抛异常」而不是返回 undefined，
    // 所以每次取服务都要包 try —— 之前就是因为这里抛了，探测日志一行都没打出来。
    let agents = null
    try {
      agents = ctx.agents || ctx.get?.('agents') || ctx.dsh?.agents || null
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-keeper] 取 agents 服务失败：${e}`)
    }

    // 第一次找之前先把上下文形状打出来——不然「拿不到 agent」只能靠猜
    if (!ctx.__keeperProbed) {
      ctx.__keeperProbed = true
      let agentKeys = null
      try {
        if (agents && typeof agents.keys === 'function') agentKeys = [...agents.keys()].slice(0, 10)
      } catch { /* ignore */ }
      const shape = {
        hasCtxAgents: !!ctx.agents,
        hasAgentsService: !!agents,
        agentKeys,
        hasSessionController: !!(ctx.sessionController || ctx.get?.('sessionController') || ctx.dsh?.get?.('sessionController') || ctx.dsh?.sessionController),
        hasSessions: !!(ctx.sessions || ctx.get?.('sessions') || ctx.dsh?.sessions),
        targetSessionId: sid || null,
      }
      ctx.logger?.info?.(`[dsh-keeper] 上下文探测：${JSON.stringify(shape)}`)
    }

    // 1) 活的
    if (agents && typeof agents.get === 'function' && sid) {
      try {
        const live = agents.get(sid) || agents.get('session-' + sid)
        if (live) return live
      } catch (e) {
        logEvent('agent-get-failed', { error: String(e) })
      }
    }

    // 2) 冷的恢复
    let ctl = null
    try {
      ctl =
        ctx.sessionController ||
        ctx.get?.('sessionController') ||
        ctx.dsh?.get?.('sessionController') ||
        ctx.dsh?.sessionController ||
        null
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-keeper] 取 sessionController 失败：${e}`)
    }
    if (ctl && typeof ctl.resolveAgent === 'function' && sid) {
      try {
        const r = await ctl.resolveAgent(sid)
        if (r && r.agent) return r.agent
      } catch (e) {
        logEvent('agent-resolve-failed', { error: String(e) })
      }
    }

    // 3) 兜底：拿第一个（单会话场景够用）
    if (agents && typeof agents.values === 'function') {
      try {
        for (const a of agents.values()) return a
      } catch { /* ignore */ }    }
    return null
  }

  /**
   * 没配 targetSessionId 时，自己找一个「最近写过东西」的会话。
   * DSH 把会话存在 ~/.dsh/storages/session_projcache/sessions/session-<uuid>.json，
   * mtime 最新的那个基本就是当前主会话。
   */
  function guessSessionId() {
    try {
      const dir = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
      if (!fs.existsSync(dir)) return null
      let best = null
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        const full = path.join(dir, f)
        const { mtimeMs } = fs.statSync(full)
        if (!best || mtimeMs > best.t) best = { f, t: mtimeMs }
      }
      if (!best) return null
      return best.f.replace(/\.json$/, '')
    } catch {
      return null
    }
  }

  /**
   * 唤醒 —— 同样抄 hub.js 的 pushToSession（hub.js:1455-1470）：
   *
   *   const message = { id: randomUUID(), role: 'user', content: [...], source: {...} }
   *   if (opts.steer && typeof agent.steer === 'function') await agent.steer(message)
   *   else await agent.followup(message)
   *   if (dsh.sessions?.flush) await dsh.sessions.flush(agent.session)
   */
  async function wake(gaps) {
    if (!canWake()) {
      logEvent('wake-throttled', { count: gaps.length })
      return { ok: false, throttled: true }
    }

    const text = formatWakeMessage(gaps)
    const message = {
      id: (globalThis.crypto?.randomUUID?.() ?? `keeper-${Date.now()}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'keeper' },
    }

    try {
      const agent = await resolveTargetAgent()
      if (!agent) throw new Error('没有可用的 agent')

      const busy =
        (typeof agent.isBusy === 'function' && agent.isBusy()) ||
        agent.busy === true ||
        agent.running === true

      if (busy && typeof agent.steer === 'function') {
        await agent.steer(message)
        logEvent('wake-steer', { ok: true })
      } else if (typeof agent.followup === 'function') {
        await agent.followup(message)
        logEvent('wake-followup', { ok: true })
      } else if (typeof agent.steer === 'function') {
        await agent.steer(message)
        logEvent('wake-steer', { ok: true, fallback: true })
      } else {
        throw new Error('agent 既没有 followup 也没有 steer')
      }

      let sessions = null
      try {
        sessions = ctx.sessions || ctx.get?.('sessions') || ctx.dsh?.sessions || null
      } catch { /* ignore */ }
      if (sessions && typeof sessions.flush === 'function') {
        try {
          await sessions.flush(agent.session)
        } catch (e) {
          logEvent('flush-failed', { error: String(e) })
        }
      }

      wakeHistory.push(Date.now())
      return { ok: true, via: busy ? 'steer' : 'followup' }
    } catch (e) {
      // 这条一定要打出来：之前只记内存，结果是「唤醒失败」四个字都看不到原因
      ctx.logger?.warn?.(`[dsh-keeper] 唤醒失败：${e}`)
      logEvent('wake-failed', { error: String(e) })
    }

    // 退路：subagent（装了那三个 rc 包才有效）
    try {
      let subs = null
      try { subs = ctx.subagents || ctx.get?.('subagents') || null } catch { /* ignore */ }
      if (subs && typeof subs.sendMessage === 'function' && config.targetAgentId) {
        await subs.sendMessage({ agentId: config.targetAgentId, message: text })
        wakeHistory.push(Date.now())
        logEvent('wake-subagent', { ok: true })
        return { ok: true, via: 'subagent' }
      }
    } catch (e) {
      logEvent('wake-subagent-failed', { error: String(e) })
    }

    degraded = true
    logEvent('wake-degraded', { text })
    return { ok: false, degraded: true }
  }

  /** 跑一轮巡检 */
  async function tick() {
    if (running) return { skipped: 'busy' }
    running = true
    const result = { at: Date.now(), checked: 0, gaps: [], errors: [] }
    try {
      for (const [id, chk] of checkers) {
        try {
          const [exp, act] = await Promise.all([chk.expected(), chk.actual()])
          const gaps = (await chk.diff(exp, act)) || []
          result.checked++
          // 每轮留痕：不写这行，「巡检跑没跑」在日志里看不到
          ctx.logger?.info?.(`[dsh-keeper] 巡检 ${id}：${gaps.length} 个问题`)
          for (const g of gaps) {
            const key = `${id}:${g.what}`
            if (!severityOk(g.severity)) continue
            if (inQuietHours() && g.severity !== 'critical') continue
            if (!notDuplicate(key)) continue
            result.gaps.push({ checker: id, ...g })
          }
        } catch (e) {
          result.errors.push({ checker: id, error: String(e) })
          ctx.logger?.warn?.(`[dsh-keeper] 检查器 ${id} 出错：${e}`)
        }
      }
      if (result.gaps.length) {
        const w = await wake(result.gaps)
        ctx.logger?.info?.(`[dsh-keeper] 唤醒结果：${JSON.stringify(w)}`)
      }
    } finally {
      running = false
    }
    return result
  }

  /** 注册检查器 */
  function register(checker) {
    if (!checker || !checker.id) throw new Error('checker 需要 id')
    for (const m of ['expected', 'actual', 'diff']) {
      if (typeof checker[m] !== 'function') throw new Error(`checker ${checker.id} 缺 ${m}()`)
    }
    checkers.set(checker.id, checker)
    logEvent('checker-added', { id: checker.id })
    return () => checkers.delete(checker.id)
  }

  /**
   * 启动定时采样。
   *
   * 踩过的坑：原先写 `typeof c.sample === 'function' ? 0 : 60000`，
   * 所有检查器都有 sample()，于是取到 0，Math.max(15000, 0) = 15 秒——
   * 变成 15 秒巡检一次。sample() 是异步的，同步的 start() 等不了，
   * 所以改用配置或默认值。
   */
  function start(periodMs) {
    if (timer) return
    const period = Math.max(30_000, Number(periodMs || config.periodMs || 180_000))
    timer = setInterval(() => {
      tick().catch(e => logEvent('tick-error', { error: String(e) }))
    }, period)
    logEvent('started', { period })
    ctx.logger?.info?.(`[dsh-keeper] 巡检周期 ${Math.round(period / 1000)} 秒`)
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
    logEvent('stopped', {})
  }

  // —— 对外工具 ——
  const tools = {
    keeper_register: async ({ checker }) => register(checker),
    keeper_tick: async () => tick(),
    keeper_status: async () => ({
      running: !!timer,
      degraded,
      checkers: [...checkers.keys()],
      limits,
      wakesLastHour: wakeHistory.length,
      recentLog: log.slice(-20),
    }),
  }

  // 工具注册要显式声明依赖，否则 ctx.tools 会抛 inject 错误
  // ⚠ 签名是 register(toolObject)：参数表叫 `parameters`（完整 JSON Schema）、执行函数叫 `execute`。
  //   写成 input + handler 会让 parameters 变成 undefined，整轮对话在工具投影时直接作废
  //   （2026-11-07 02:48 就是这样被宿主摘掉插件的）。形状照抄 dsh-wallet/index.js:33-43。
  const S = (description) => ({ type: 'string', description })
  const O = (description) => ({ type: 'object', description })
  const TOOL_META = {
    keeper_register: { desc: '注册一个检查器（期望/实际/diff/sample）', params: { checker: O('检查器定义') } },
    keeper_tick:     { desc: '手动跑一轮巡检（调试用）', params: {} },
    keeper_status:   { desc: '看运行状态、已注册检查器、四道闸、最近日志', params: {} },
  }
  ctx.inject?.(['tools'], (sub) => {
    for (const [toolName, handler] of Object.entries(tools)) {
      const meta = TOOL_META[toolName] || { desc: toolName, params: {} }
      try {
        sub.tools.register({
          name: toolName,
          description: meta.desc,
          parameters: {
            type: 'object',
            properties: meta.params || {},
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
          },
          timeoutMs: 30000,
          isConcurrencySafe: () => false,
          execute: async (args) => handler(args || {}),
        })
      } catch (e) {
        logEvent('tool-register-failed', { toolName, error: String(e) })
        ctx.logger?.warn?.(`[dsh-keeper] 工具注册失败 ${toolName}: ${e}`)
      }
    }
  })

  // —— 内置检查器：装着就能用的现成货 ——
  const builtins = {
    stellaris: async () => {
      const mod = await import('./checkers/stellaris.js')
      return mod.default
    },
    'think-backlog': async () => {
      const mod = await import('./checkers/think-backlog.js')
      return mod.default
    },
    'video-assets': async () => {
      const mod = await import('./checkers/video-assets.js')
      return mod.default
    },
  }

  const builtinIds = Array.isArray(config.builtins) ? config.builtins : ['stellaris', 'think-backlog', 'video-assets']
  const loaded = []

  const builtinLoad = (async () => {
    for (const id of builtinIds) {
      const factory = builtins[id]
      if (!factory) { logEvent('builtin-unknown', { id }); continue }
      try {
        const make = await factory()
        const checker = make(config.builtinsConfig?.[id] || {})
        register(checker)
        loaded.push(id)
        logEvent('builtin-loaded', { id })
      } catch (e) {
        logEvent('builtin-failed', { id, error: String(e) })
      }
    }
    return loaded
  })()

  // 配置里直接给的检查器对象
  if (Array.isArray(config.checkers)) {
    for (const c of config.checkers) {
      try { register(c) } catch (e) { logEvent('checker-rejected', { error: String(e) }) }
    }
  }

  ctx.on?.('dispose', () => stop())

  // 启动留痕：没这行，「加载成功」和「压根没被 include」在日志里长得一模一样。
  // 等内置检查器 import 完再打，否则会看到「检查器 0 个」的假象。
  builtinLoad.then((ids) => {
    if (config.autoStart !== false && checkers.size && !timer) start()
    try {
      ctx.logger?.info?.(
        `[dsh-keeper] 已加载 v0.1.0 | 检查器 ${checkers.size} 个${ids.length ? `（内置：${ids.join(',')}）` : ''} | 自动巡检 ${timer ? '开' : '关'}`
      )
    } catch { /* ignore */ }
  })

  return { register, tick, start, stop }
}

export default { name, inject, apply }
