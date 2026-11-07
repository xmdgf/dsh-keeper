/**
 * 离线自检：造假 ctx，直接 import 插件跑。
 * 注意假 ctx 的 register 签名必须跟真的一样：register(toolObject)
 */
import { apply, name } from './index.js'

const registered = []
const fakeCtx = {
  inject(deps, fn) {
    fn({
      tools: {
        register(tool) {
          if (!tool || typeof tool !== 'object' || !tool.name) {
            throw new Error(`bad tool object: ${JSON.stringify(tool)}`)
          }
          // 注意：真插件用的是 execute，不是 handler
          if (typeof tool.execute !== 'function') {
            throw new Error(`tool ${tool.name} 缺 execute()`)
          }
          registered.push({ name: tool.name, execute: tool.execute })
        },
      },
    })
  },
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.warn('[warn]', m) },
}

apply(fakeCtx, { autoStart: false })

console.log('插件名:', name)
console.log('注册工具:', registered.map((t) => t.name).join(', ') || '(无)')

const call = (n, args = {}) => registered.find((t) => t.name === n)?.execute(args)

let failed = registered.length === 0

const status = await call('keeper_status')
if (status) {
  console.log('\nkeeper_status:')
  console.log('  running =', status.running)
  console.log('  degraded =', status.degraded)
  console.log('  checkers =', JSON.stringify(status.checkers))
  console.log('  limits =', JSON.stringify(status.limits))
} else {
  console.log('\nkeeper_status 不可用')
  failed = true
}

const tick = await call('keeper_tick')
console.log('\nkeeper_tick:', JSON.stringify(tick))
if (!tick || typeof tick.checked !== 'number') failed = true

console.log('\n---')
console.log(failed ? '结果: 失败' : '结果: 通过')
process.exit(failed ? 1 : 0)
