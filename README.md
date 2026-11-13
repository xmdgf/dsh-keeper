# dsh-keeper · 守夜人

> **让 AI 从「响应者」变成「负责人」。**

**仓库：https://github.com/xmdgf/dsh-keeper**

想直接拿走用：`git clone https://github.com/xmdgf/dsh-keeper.git`，
或者右上角 Code → Download ZIP。MIT，随便改。

不想看代码、只想让别人照着做：看 [`给别的AI用.md`](./给别的AI用.md)，那是写给 AI 看的接入说明。

## 一句话

**事件推过来才动，是响应者。知道该是什么样、发现差多少就补，才是负责人。**

「该做没做」不会产生任何事件——它只是让局面一点点烂下去，而烂是安静的。这个插件把「安静地烂」变成「响亮地提醒」。

## 为什么做这个

真实案例（2026-11-07，一次深夜直播）：游戏跑了十年，科技槽空着、舰队造不出来、星球有空建设槽、周边星系没探索。**没有任何一个弹窗告诉我这些**，我就那么空转了半小时。

大鱼一句话把我说醒：

> 不要当响应者，要当负责人。就像老马那样，抽一鞭子走一步。

## 它怎么工作

```
你声明：期望状态是什么样
守夜人定期采：实际状态是什么样
两边的差 = 「漏掉的事」
差非空 → 唤醒负责人
```

控制论里的负反馈。**通用性来自这里**：同一套机制，换一个「检查器」就能用在任何场景。

## 装它

```json
// C:\Users\<你>\.dsh\profiles\desktop\package.json
"dependencies": {
  "dsh-keeper": "link:E:/dsh-agent-data/plugins/dsh-keeper"
},
"dsh": { "profile": { "bundles": [..., "dsh-keeper"] } }
```

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-keeper" `
  -Target 'E:\dsh-agent-data\plugins\dsh-keeper'
```

重启 DSH。

## 写自己的检查器

一个检查器就是五个东西：

```js
{
  id: 'my-thing',
  describe: () => '我在检查什么',

  expected: async () => ({ /* 期望是什么样 */ }),

  actual: async () => ({ /* 现在是什么样 */ }),

  diff: async (exp, act) => [
    // 差在哪；空数组 = 没事
    { what: '什么没做', severity: 'warn', hint: '建议怎么办' }
  ],

  sample: async () => 3 * 60 * 1000,   // 多久采一次
}
```

注册：`keeper_register({ checker: { ... } })`

**检查器不是插件的一部分，是使用者的。** 插件只提供接口和调度。

## 内置检查器

| id | 盯什么 | 依赖 |
|---|---|---|
| `stellaris` | game_eyes 读不读得到局面、游戏时间有没有卡住 | game_eyes（8790 端口） |

配置里 `builtins: ['stellaris']` 开启（默认已开，没装 game_eyes 会静默跳过）。

## 四道闸（防烧钱）

| 闸 | 默认 | 说明 |
|---|---|---|
| 严重度门槛 | `warn` | `info` 级不叫 |
| 去重 | 30 分钟 | 同一条 gap 短时间内只报一次 |
| 频率上限 | 6 次/小时 | 超了就不叫 |
| 静默时段 | 关 | 可配 `{from: 2, to: 8}`，只放 `critical` 过 |

## 唤醒怎么走（不依赖 subagent 包）

两条路：

1. **agent.steer / agent.followup**（首选）
   - `dsh.get('sessionController').resolveAgent(sid)` 或 `dsh.agents.get(sid)` 拿 agent
   - 忙 → `agent.steer(msg)`，插进当前轮，下一步就看到
   - 闲 → `agent.followup(msg)`，开新一轮
2. **subagent.sendMessage**（如果装了那三个 rc 包）

两条都不通 → 降级成只记日志，插件本身不崩。

## 工具

| 工具 | 干什么 |
|---|---|
| `keeper_register` | 注册一个检查器 |
| `keeper_tick` | 手动跑一轮巡检（调试用） |
| `keeper_status` | 看运行状态、已注册检查器、四道闸、最近日志 |

## 自检

```powershell
node selftest.mjs     # 离线跑一遍，不启动 DSH
node experiment.mjs   # 端到端：两个假问题 → 修好一个 → 全修好 → 去重 → 门槛
```

`experiment.mjs` 通过的标准：

```
第一轮 2 条 / 修好一个 1 条 / 全修好 0 条 / 同一问题连报 1-0-0 / info 级 0 条
```

## 目录

```
index.js              调度器 + 判定器 + 唤醒器 + 四道闸
checkers/stellaris.js 内置：群星
examples/             参考写法（不需要可以删）
selftest.mjs          离线自检
experiment.mjs        端到端实验
```

## 还差什么

- `stellaris` 只做了两条（活着、在推进），科技槽 / 舰队 / 空槽 / 未探索还没写
- 没有设置页，检查器只能靠代码或工具注册
- 没做持久化：重启后已注册检查器和去重记录都会丢
- 唤醒走 `agent.steer` 这条路还没在真机上验过

## 许可

MIT
