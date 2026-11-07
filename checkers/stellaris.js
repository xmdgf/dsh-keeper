/**
 * 内置检查器：群星（Stellaris）
 *
 * 「期望 vs 实际」落到具体场景的第一个样板，读懂它就会写自己的。
 * 依赖 game_eyes 的 HTTP 接口（默认 http://127.0.0.1:8790）。
 *
 * 现在的期望（每条都是一句「本该如此」）：
 *   1. game_eyes 活着，读得到局面
 *   2. 游戏没卡在暂停上（暂停超过 pauseMinutes 就报）
 *   3. 游戏时间在走（stuckMinutes 内日期变过）
 *   4. 没有资源是负的（吃老本会一路吃到崩）
 *   5. 关键资源没有归零（凝聚力 0 意味着传统停摆）
 *
 * 还想加但还没做的：
 *   - 科技槽空着
 *   - 舰队全闲着
 *   - 星球有空建设槽
 *   - 周边星系没探索
 */

import http from 'node:http'

const DEFAULTS = {
  eyesUrl: 'http://127.0.0.1:8790',
  stuckMinutes: 10,
  pauseMinutes: 3,
  sampleMs: 3 * 60 * 1000,
  /** 归零要盯的关键资源（按名字匹配 raw 位置不稳，这里用「第几项」的粗口径 + 数值判断） */
  zeroWarnBelow: 0,
}

function getJson(base, path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + path, { timeout: timeoutMs }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (b += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(b))
        } catch {
          resolve({ raw: b })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('game_eyes 超时')))
    req.on('error', reject)
  })
}

/** '25K+76' → { stock: 25000, net: 76 }（K/M 后缀按千/百万算） */
function parseNum(s) {
  const m = /^([\d.]+)([KM]?)\+?(-?[\d.]+)?$/.exec(String(s).trim())
  if (!m) return null
  const mult = m[2] === 'K' ? 1000 : m[2] === 'M' ? 1000000 : 1
  return {
    raw: s,
    stock: parseFloat(m[1]) * mult,
    net: m[3] === undefined || m[3] === '' ? null : parseFloat(m[3]),
  }
}

/**
 * 工厂函数：插件加载内置检查器时会调它。
 * @param {object} options 来自配置的 builtinsConfig.stellaris
 */
export default function createStellarisChecker(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  let lastDate = null
  let lastDateAt = 0
  let pausedSince = 0

  return {
    id: 'stellaris',
    describe: () => '群星：读得到局面、没卡在暂停、时间在走、资源没崩',

    // 期望：活着 + 没卡住 + 在推进 + 资源不崩
    expected: async () => ({
      alive: true,
      paused: false,
      progressing: true,
      noNegative: true,
      noZeroCritical: true,
    }),

    // 实际：去问 game_eyes
    actual: async () => {
      let board = null
      try {
        const r = await getJson(cfg.eyesUrl, '/status')
        if (r && !r.error) {
          board = {
            date: r.date || '',
            numbers: r.numbers || [],
            paused: r.paused === true,
            speed: r.speed || null,
          }
        }
      } catch {
        board = null
      }
      if (!board) {
        return {
          alive: false,
          paused: false,
          progressing: false,
          noNegative: true,
          noZeroCritical: true,
          board: null,
          stuckMin: 0,
          pausedMin: 0,
          negatives: [],
          zeros: [],
        }
      }

      const now = Date.now()
      // 时间推进。读不到日期（主菜单 / 弹窗挡着）时 **不算停住**——
      // 这时候日期本来就不该变，把它当「卡住」是误报（2026-11-07 被它吵了两次）。
      if (board.date && board.date !== lastDate) {
        lastDate = board.date
        lastDateAt = now
      }
      const stuckMs = board.date && lastDateAt ? now - lastDateAt : 0

      // 暂停计时
      if (board.paused) {
        if (!pausedSince) pausedSince = now
      } else {
        pausedSince = 0
      }
      const pausedMs = pausedSince ? now - pausedSince : 0

      // 资源：负数 + 归零
      const nums = board.numbers.map(parseNum).filter(Boolean)
      const negatives = nums.filter((n) => n.net !== null && n.net < 0).map((n) => n.raw)
      const zeros = nums
        .filter((n) => n.stock === 0 && (n.net === null || n.net === 0))
        .map((n) => n.raw)

      // 科技槽空着：这是「一直原地踏步」最隐蔽的一种。
      // 群星里科技一研究完槽就空了，不选就等于白跑——我从 2234 年白跑到 2254 年才发现。
      let techGaps = null
      try {
        const t = await getJson(cfg.eyesUrl, '/techgaps')
        if (t && typeof t.gaps === 'number') techGaps = t.gaps
      } catch {
        techGaps = null
      }

      return {
        alive: true,
        paused: board.paused,
        speed: board.speed,
        progressing: stuckMs < cfg.stuckMinutes * 60 * 1000,
        noNegative: negatives.length === 0,
        noZeroCritical: zeros.length === 0,
        techGaps,
        board,
        stuckMin: Math.floor(stuckMs / 60000),
        pausedMin: Math.floor(pausedMs / 60000),
        negatives,
        zeros,
      }
    },

    // 两边一比，差的就是「该做没做」
    diff: async (exp, act) => {
      const gaps = []
      if (!act.alive) {
        gaps.push({
          what: 'game_eyes 读不到局面',
          severity: 'critical',
          hint: `检查 ${cfg.eyesUrl} 和游戏是否在前台`,
        })
        return gaps
      }

      // 暂停太久：这是群里最容易被忽略的一种「什么都没做」
      if (act.paused && act.pausedMin >= cfg.pauseMinutes) {
        gaps.push({
          what: `游戏暂停了 ${act.pausedMin} 分钟还没继续（${act.board.date}）`,
          severity: 'warn',
          hint: '多半是弹窗/事件在等你点，去看一眼；确认无事就点继续',
        })
      } else if (!act.progressing) {
        gaps.push({
          what: `游戏时间停住了：${act.board.date} 已经 ${act.stuckMin} 分钟没动`,
          severity: 'warn',
          hint: '可能按了暂停，或被弹窗挡住',
        })
      }

      // 资源转负
      if (!act.noNegative) {
        gaps.push({
          what: `有资源在往下掉：${act.negatives.join('、')}`,
          severity: 'warn',
          hint: '吃老本吃到头就会连锁崩，看看是不是该建区划/调岗位',
        })
      }

      // 关键资源归零
      if (!act.noZeroCritical) {
        gaps.push({
          what: `有资源彻底归零：${act.zeros.join('、')}`,
          severity: 'info',
          hint: '归零的那项多半是凝聚力/影响力一类，断了会让传统或外交停摆',
        })
      }

      // 科技槽空着：最隐蔽的「该做没做」。研究完就空，不选等于白跑。
      if (typeof act.techGaps === 'number' && act.techGaps > 0) {
        gaps.push({
          what: `有 ${act.techGaps} 个科技槽空着（${act.board.date}）`,
          severity: 'warn',
          hint: '群星里科技一研究完槽就空了，不选就是原地踏步；点左上角的「选择科技」补上',
        })
      }

      return gaps
    },

    sample: async () => cfg.sampleMs,
  }
}
