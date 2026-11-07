/**
 * 内置检查器：视频素材齐不齐
 *
 * 踩过的教训：立绘从头到尾一个表情 = 偷懒；标签少一个 = 少一拨人。
 * 这个检查器盯着素材目录，缺东西就提醒。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  faceDir: path.join('E:', 'dsh-agent-data', 'tools', 'char_faces'),
  requiredFaces: ['normal.png', 'closed.png', 'sad.png', 'wide.png'],
  charFile: path.join('E:', 'dsh-agent-data', 'tools', 'char_alpha.png'),
  sampleMs: 30 * 60 * 1000,
}

export default function createAssetsChecker(options = {}) {
  const cfg = { ...DEFAULTS, ...options }

  return {
    id: 'video-assets',
    describe: () => '做视频的素材：立绘、表情变体',

    expected: async () => ({
      char: true,
      faces: cfg.requiredFaces.length,
    }),

    actual: async () => {
      const hasChar = fs.existsSync(cfg.charFile)
      let faces = []
      try {
        faces = fs.existsSync(cfg.faceDir)
          ? fs.readdirSync(cfg.faceDir).filter((f) => f.endsWith('.png'))
          : []
      } catch { /* ignore */ }
      return { hasChar, faces, count: faces.length }
    },

    diff: async (exp, act) => {
      const gaps = []
      if (!act.hasChar) {
        gaps.push({
          what: '主立绘 char_alpha.png 不见了',
          severity: 'critical',
          hint: `查 ${cfg.charFile}`,
        })
        return gaps
      }
      const missing = cfg.requiredFaces.filter((f) => !act.faces.includes(f))
      if (missing.length) {
        gaps.push({
          what: `表情变体缺 ${missing.length} 个：${missing.join('、')}`,
          severity: 'warn',
          hint: '跑一下 tools\\make_faces.py 重新生成',
        })
      }
      return gaps
    },

    sample: async () => cfg.sampleMs,
  }
}
