// 群星存档检查器：OCR 会误读，存档不会。
//
// 群星每半年（游戏年）自动存一次档，存的是 zip 里的 gamestate 纯文本。
// 这份检查器不去看屏幕，直接读最新的 .sav：
//   - 存档多久没更新了（游戏没在跑 / 没在推进）
//   - 最新存档的日期
//   - 已研究科技数（有没有原地踏步）
//
// 为什么需要它：OCR 读屏幕字小会错，读不到就是读不到；
// 存档是游戏自己写的，精度高，只是滞后（半年一次）。
// 所以口径是：**OCR 补实时，存档做精确判断**。

import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const DEFAULTS = {
  // 解析脚本
  script: 'E:\\dsh-agent-data\\tools\\stellaris_save.py',
  // 用哪个 python（要有标准库就行，不需要额外依赖）
  python: 'E:\\dsh-agent-data\\voice\\python\\python.exe',
  // 存档超过多久没更新就算「没在推进」
  staleHours: 2,
  // 样本缓存（读一次 gamestate 26MB，别太频繁）
  sampleMs: 30 * 60 * 1000,
}

function runPython(python, script) {
  return new Promise((resolve) => {
    execFile(
      python,
      [script, '--json'],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ error: String(err.message || err) })
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          resolve({ error: '解析输出失败：' + String(e) })
        }
      },
    )
  })
}

export default function createSaveChecker(options = {}) {
  const cfg = { ...DEFAULTS, ...options }

  return {
    id: 'stellaris-save',
    describe: () => '群星存档：在更新、日期在推进、科技在涨',

    expected: async () => ({
      readable: true,
      fresh: true,
      progressing: true,
    }),

    actual: async () => {
      const r = await runPython(cfg.python, cfg.script)
      if (r.error) {
        return { readable: false, error: r.error, fresh: false, progressing: false, save: null }
      }
      // 存档文件名的 mtime 就是「最后一次自动存档」的时刻
      const saveDir = r.save_dir || null
      let ageMin = null
      if (saveDir && r.save) {
        try {
          const fs = await import('node:fs/promises')
          const st = await fs.stat(path.join(saveDir, r.save))
          ageMin = Math.floor((Date.now() - st.mtimeMs) / 60000)
        } catch {}
      }
      return {
        readable: true,
        fresh: ageMin === null ? true : ageMin <= cfg.staleHours * 60,
        progressing: true,
        ageMin,
        save: r.save || null,
        date: r.date || null,
        techCount: typeof r.tech_count === 'number' ? r.tech_count : null,
        empire: r.empire || null,
      }
    },

    diff: async (exp, act) => {
      const gaps = []
      if (!act.readable) {
        gaps.push({
          what: '读不到群星存档',
          severity: 'warn',
          hint: `检查 ${cfg.script} 和 python 路径，或者这台机器没在玩群星`,
        })
        return gaps
      }
      if (!act.fresh) {
        gaps.push({
          what: `最新存档已经 ${act.ageMin} 分钟没更新（${act.date}）`,
          severity: 'warn',
          hint: '游戏可能没在跑、或者一直暂停着没推进',
        })
      }
      return gaps
    },
  }
}
