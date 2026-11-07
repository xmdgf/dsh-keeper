/**
 * 示例检查器：群星（Stellaris）
 *
 * 演示「期望 vs 实际」怎么落到一个具体游戏上。
 * 依赖 game_eyes 的 HTTP 接口（127.0.0.1:8790）。
 *
 * 用法：
 *   const keeper = ctx.keeper
 *   keeper.register(require('./examples/stellaris.js').createChecker({}))
 */

import http from 'node:http'

const EYES = 'http://127.0.0.1:8790'

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(EYES + path, { timeout: 15000 }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (b += c))
      res.on('end', () => {
        try { resolve(JSON.parse(b)) } catch { resolve({ raw: b }) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('game_eyes 超时')))
    req.on('error', reject)
  })
}

/**
 * 从截图里读局面。
 * 这里只读「日期」和「顶部资源数字」——足够证明机制，不用一开始就把所有东西都啃下来。
 */
async function readBoard() {
  const r = await get('/status')
  if (!r || r.error) return null
  return {
    date: r.date || '',
    numbers: Array.isArray(r.numbers) ? r.numbers : [],
    raw: r.raw || '',
  }
}

export function createChecker(options = {}) {
  const cfg = {
    idleFleetWarn: 2,     // 闲置舰队超过这个数就 warn
    staleDays: 365 * 3,   // 游戏里三年没到新日期 = 卡住了
    ...options,
  }
  let lastDate = null
  let lastDateSeenAt = 0

  return {
    id: 'stellaris',
    describe: () => '群星：该点没点的东西、卡住的进度',

    expected: async () => ({
      alive: true,
      progressing: true,
    }),

    actual: async () => {
      const board = await readBoard()
      if (!board) return { alive: false, progressing: false, board: null }

      const now = Date.now()
      if (board.date !== lastDate) {
        lastDate = board.date
        lastDateSeenAt = now
      }
      const stuckMs = lastDateSeenAt ? now - lastDateSeenAt : 0

      return {
        alive: true,
        progressing: stuckMs < 10 * 60 * 1000,   // 十分钟没变日期 = 可能暂停了
        board,
      }
    },

    diff: async (exp, act) => {
      const gaps = []
      if (!act.alive) {
        gaps.push({ what: 'game_eyes 读不到局面', severity: 'critical', hint: '检查 8790 端口和游戏是否在前台' })
        return gaps
      }
      if (!act.progressing) {
        gaps.push({ what: `游戏时间停在 ${act.board.date}`, severity: 'warn', hint: '可能暂停了，或被弹窗挡住' })
      }
      return gaps
    },

    sample: async () => 3 * 60 * 1000,
  }
}

export default { createChecker }
