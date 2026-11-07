/**
 * 检查器模板 —— 写自己的检查器就从这复制。
 *
 * 一个检查器 = 五样东西：
 *   id / describe / expected / actual / diff / sample
 *
 * 核心思想：不要写「出事了怎么办」，要写「应该是什么样」。
 * 事件会自己响，没做不会响——所以后者才是要盯的。
 */

export default function createMyChecker(options = {}) {
  const cfg = {
    // 你自己要的参数，带上默认值
    threshold: 3,
    sampleMs: 5 * 60 * 1000,
    ...options,
  }

  return {
    /** 唯一标识，会出现在日志和唤醒消息里 */
    id: 'my-checker',

    /** 一句人话：我在检查什么 */
    describe: () => '一句话说清我在盯什么',

    /** 期望状态：应该是什么样。可以是一组断言。 */
    expected: async () => ({
      count: cfg.threshold,
    }),

    /** 实际状态：现在是什么样。采数据都写在这。 */
    actual: async () => {
      // 例子：
      // const r = await fetch('http://127.0.0.1:8790/status')
      // const data = await r.json()
      return { count: 0 }
    },

    /** 比一比，差在哪。空数组 = 没事，不叫。 */
    diff: async (exp, act) => {
      const gaps = []

      if (act.count < exp.count) {
        gaps.push({
          what: `差 ${exp.count - act.count} 个`,
          // info 不叫（被门槛挡住）、warn 叫、critical 一定叫
          severity: 'warn',
          // 建议怎么办。写得具体点，接手的人不用再查。
          hint: '去把缺的补上',
        })
      }

      return gaps
    },

    /** 多久采一次。默认 5 分钟；太密会烧钱。 */
    sample: async () => cfg.sampleMs,
  }
}
