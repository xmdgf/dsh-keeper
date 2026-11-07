/**
 * 端到端实验 v3：证明守夜人真的能发现「该做没做」
 *
 * v1/v2 的坑：gap 的 what 用同一个全局 round，导致去重把「修好又坏」也吃掉了。
 * 这是实验的 bug，不是插件的。
 *
 * 用法：node experiment.mjs
 */
import { apply } from './index.js'

const world = { ticks: 0, techSlot: null }

const handlers = {}
apply({
  inject(deps, fn) { fn({ tools: { register(n, h) { handlers[n] = h } } }) },
  logger: { info: () => {}, warn: () => {} },
  on: () => {},
}, {})

let seq = 0
function mkChecker(id, desc, fn) {
  return {
    checker: {
      id,
      describe: desc,
      expected: async () => ({}),
      actual: async () => ({}),
      diff: async () => fn(),
      sample: async () => 1000,
    },
  }
}

const r1 = await handlers.keeper_register(mkChecker('heartbeat', '游戏有没有卡住',
  () => (world.ticks > 0 ? [] : [{ what: `心跳停了#${++seq}`, severity: 'warn', hint: '看 game_eyes 活着没' }])))
const r2 = await handlers.keeper_register(mkChecker('tech-slot', '科技槽空不空',
  () => (world.techSlot ? [] : [{ what: `科技槽空着#${++seq}`, severity: 'warn', hint: '点开科技树' }])))

console.log('注册结果:', JSON.stringify([r1, r2]))

console.log('\n=== 一、两个问题都在 ===')
const a1 = await handlers.keeper_tick({})
console.log('checked =', a1.checked, '| gaps =', a1.gaps.length)
a1.gaps.forEach(g => console.log('   ·', g.what))

console.log('\n=== 二、修好其中一个（心跳动了）===')
world.ticks = 1
const a2 = await handlers.keeper_tick({})
console.log('gaps =', a2.gaps.length)
a2.gaps.forEach(g => console.log('   ·', g.what))

console.log('\n=== 三、两个都修好 ===')
world.techSlot = '武器'
const a3 = await handlers.keeper_tick({})
console.log('gaps =', a3.gaps.length, '（应为 0）')

console.log('\n=== 四、去重闸：完全同一个问题连报三次 ===')
await handlers.keeper_register({
  checker: {
    id: 'stuck', describe: '固定问题',
    expected: async () => ({}), actual: async () => ({}),
    diff: async () => [{ what: '同一个问题', severity: 'warn' }],
    sample: async () => 1000,
  },
})
const d1 = await handlers.keeper_tick({})
const d2 = await handlers.keeper_tick({})
const d3 = await handlers.keeper_tick({})
console.log('三轮 gaps 数 =', d1.gaps.length, '/', d2.gaps.length, '/', d3.gaps.length, '（第 1 轮应为 1，后两轮 0）')

console.log('\n=== 五、严重度门槛 ===')
await handlers.keeper_register({
  checker: {
    id: 'info-only', describe: '只报 info',
    expected: async () => ({}), actual: async () => ({}),
    diff: async () => [{ what: '小事一桩', severity: 'info' }],
    sample: async () => 1000,
  },
})
const s1 = await handlers.keeper_tick({})
console.log('info 级进结果了吗:', s1.gaps.filter(g => g.checker === 'info-only').length, '（应为 0，门槛 warn）')

console.log('\n=== 六、状态 ===')
const st = await handlers.keeper_status({})
console.log('running =', st.running, '| degraded =', st.degraded)
console.log('checkers =', JSON.stringify(st.checkers))
