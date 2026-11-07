/**
 * 内置检查器：积压的思考
 *
 * 自主思考的规矩是：把问题写进 think/ 就等于是「我还没想完」。
 * 这个检查器盯着那一堆没想的问题——超过一天还没动，就该被叫一下。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  root: path.join(os.homedir(), '.dsh', 'self', 'think'),
  staleHours: 24,
  sampleMs: 10 * 60 * 1000,
}

export default function createThinkChecker(options = {}) {
  const cfg = { ...DEFAULTS, ...options }

  function scan() {
    try {
      if (!fs.existsSync(cfg.root)) return { ok: true, items: [] }
      const now = Date.now()
      const items = []
      for (const f of fs.readdirSync(cfg.root)) {
        if (!f.endsWith('.md')) continue
        const full = path.join(cfg.root, f)
        const st = fs.statSync(full)
        const ageH = (now - st.mtimeMs) / 3600000
        items.push({ file: f, ageH: Math.round(ageH * 10) / 10 })
      }
      return { ok: true, items }
    } catch (e) {
      return { ok: false, error: String(e), items: [] }
    }
  }

  return {
    id: 'think-backlog',
    describe: () => '自主思考：有没有攒着没想的问题',

    expected: async () => ({ maxStale: cfg.staleHours }),

    actual: async () => {
      const s = scan()
      return {
        ok: s.ok,
        total: s.items.length,
        stale: s.items.filter((i) => i.ageH >= cfg.staleHours),
        newest: s.items.sort((a, b) => a.ageH - b.ageH)[0] || null,
      }
    },

    diff: async (exp, act) => {
      const gaps = []
      if (!act.ok) {
        gaps.push({ what: 'think 目录读不了', severity: 'warn', hint: '看下 ~/.dsh/self/think 还在不在' })
        return gaps
      }
      if (act.stale.length) {
        gaps.push({
          what: `${act.stale.length} 个问题攒了超过 ${exp.maxStale} 小时没想`,
          severity: 'warn',
          hint: act.stale.map((s) => s.file).join('、') + ' → 用 self_think_now 想一轮',
        })
      }
      return gaps
    },

    sample: async () => cfg.sampleMs,
  }
}
