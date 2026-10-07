# dsh-petkit-pet

把 **PetKit 桌宠（蓝色大肥鱼）** 挂进 DSH Web GUI，并让它跟着 agent 的**真实运行态**动。

不是"网页上的装饰图"——它读的是 DSH 宿主的权威事件流：我在思考它就想事情，我调工具它就打字，
我等你回答它就摆出期待的样子。

## 安装

**程序与素材分家。** 这个包里只有几十 KB 的程序（`index.js` / `web/*.js` / `pet.css` /
`cordis.patch.yml` / `tools/`），**不含任何 GIF 转出来的动画**——那是百 MB 级、且每套 GIF
都不一样的东西，放在 `<assetsDir>`（默认 `<DSH_HOME>/petkit-assets`）下另行同步。

### 1) 装程序

```powershell
# 从 tarball（实体复制，装完不依赖来源目录）
dsh plugin --profile web add "file:E:\deepseek\desktop-pet\dist\dsh-petkit-pet-0.1.0.tgz"
# 或从源码目录（改完无需重装，前端文件是 no-store 每次重读）
dsh plugin --profile web add link:E:\deepseek\desktop-pet\dsh-petkit-pet
```

**桌面端（Electron）不能用 npm 装出来的 `dsh`**——它按设计拒绝 `desktop` profile
（`profile "desktop" is managed exclusively by the Electron application`）。
要用桌面端自带的那一支，而且**不必退出 App**：

```powershell
& 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
    plugin --profile desktop add "file:E:\deepseek\desktop-pet\dist\dsh-petkit-pet-0.1.0.tgz"
```

> 桌面端还有一个前提：它的索引注入表是**宿主启动时一次性收集**的，
> 所以新装或改装之后要**重开一次桌面端**才会看到桌宠（只刷新页面不够）。

### 2) 同步素材（不做这步桌宠不会出现）

```powershell
node tools/sync-assets.mjs E:\deepseek\desktop-pet\out\html
```

第一条参数是 `convert_pet.py` 的输出目录，第二条（可省）是素材根。
它会做「清单 ↔ 文件一一对应」核对，并**清理孤儿产物**（改了素材池后留下的旧 webp）。

素材根可以指到别处，在 profile 的 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- insert:
    - id: petkit-pet
      name: dsh-petkit-pet
      config:
        assetsDir: 'E:\my-pet-assets'    # 布局：pet/*.webp 与 pet-manifest.js
        right: 20
        bottom: 150
        zIndex: 9999
        enabled: true
```

素材本身的制作与**命名要求**见 [注意事项.md](./注意事项.md)（命名必须描述动作本身）。

### 3) 卸载

```powershell
dsh plugin --profile web remove dsh-petkit-pet
```

素材根不会被自动删除——自己决定要不要清。

## 状态映射

状态来自 `ctx.on('session/event')`（DSH 的权威会话事件流），不是前端猜的。

| 桌宠 | 触发信号 | 说明 |
|---|---|---|
| `think` | `step/start`、`tool/result` 之后 | 模型正在想 |
| `tool` | `tool/call`（非提问类工具） | 正在调工具 |
| `reply` | `assistant/message` | 正在生成回复 |
| `run` | `command/run`、`tool-workflow/run-start`、`tool/ptc-dispatch-start` | 跑命令/工作流 |
| `wait` | `tool/call` 且工具名是 `ask_user_question`，或 `approval/asked` | **在等你回答或授权** |
| `link` | 页面刚加载、还没收到第一帧状态 | 连接中 |
| `sseErr` | SSE 断开 | 断线 |
| `idle` | 没有打开的回合 | 空闲（含移入 hook / 点击摸头 / 5 秒后入睡） |

跨会话规则，按顺序：

1. **任何会话有挂起的提问/审批 → `wait`**。这是注意力信号：哪怕你在别的会话里，桌宠也该先提醒你有东西在等。
2. 否则取**最近活跃**（单调计数判定）的开放回合的状态。
3. 都没有 → 空闲。

## 配置

全部可选，写在 `cordis.patch.yml` 的 insert 行上；不写就用 `web/pet.css` 的默认值。

```yaml
- insert:
    - id: petkit-pet
      name: dsh-petkit-pet
      config:
        enabled: true     # false = 完全不注入
        right: 20         # 距右 px
        bottom: 150       # 距底 px（DSH 的 composer 在底部，太小会被挡）
        zIndex: 9999
```

桌宠可以用鼠标拖着走（套件自带拖拽）；位置不会记忆，刷新回到配置的落点。

## 变化（157 张素材全用上）

`web/pet/` 里不是 14 张而是 **157 张**动画——「蓝色大肥鱼表情包」的全部素材，一张不浪费。
每个状态有多个**变体**（`loop-idle`、`loop-idle-2`、`loop-idle-3`…），前端从 manifest
推導清单，用套件自带的 `chatPetPick` 轮换（不连续重复）。

| 分组 | 变体数 | 说明 |
|---|---|---|
| `loop-idle` | 34 | 基础待机——看得最久，变化最多 |
| `after-idle-check` | 45 | 点击回应（摸头 / 爱心 / 生气 / 掏刀…） |
| `loop-sseErr` | 13 | 断线（死亡 / 坐牢 / 哭…） |
| `loop-run` | 11 | 执行长任务（工作 / 打游戏 / 带薪拉屎…） |
| `loop-tool` | 10 | 调工具（打字 / 记录 / 抓拍…） |
| `loop-link` | 8 | 连接中（冒泡 / 通知…） |
| `loop-wait` | 7 | 等你回答（期待 / 紧张 / 害羞…） |
| `loop-reply` | 7 | 生成回复（唱歌 / 扩音器 / 干杯…） |
| `loop-think` | 6 | 思考（正在思考 / 六七…） |
| `before-idle` | 6 | 整轮收尾（一切都好 / 自我安慰…） |
| `loop-idle-hook` | 5 | 鼠标移入（打招呼 / 摇铃 / 点头…） |
| `loop-idle-sleep` | 4 | 睡着（睡觉 / 催眠…） |
| `before-idle-sleep` | 1 | 入睡过渡 |

分桶表在 [`../asset-map.json`](../asset-map.json)：改完重跑
`../petkit/tools/build_gifs_src.py` 再跑 `../petkit/scripts/convert_pet.py` 即生效。
没被显式分桶的标签走 `_fallback` 全进 `loop-idle`——这是「一张都不浪费」的做法，
想调整就把标签从 fallback 里挑出来写进别的分组。

**为什么不全部预载**：157 张约 100 MB，全预载会拖慢启动（套件的载入闸门要等全部载完
才开放调度）并白吃上百 MB 内存。所以只预载 **19 张**（各分组首张 + 前 6 张待机变体），
其余按需载入——本机同源，且 webp 走 `immutable` + 内容哈希 URL，第二次就命中浏览器缓存。

**变体配对规则**：`before-*` 与 `loop-*` 按**下标配对**（第 i 个 before 配第 i 个 loop）；
`before` 缺失时直接进 `loop`，所以加 loop 变体不必被迫造一堆没有意义的 before 素材。

## 结构

**包内（随包发布，约 90 KB）**

```
index.js           宿主半侧：状态跟踪 + SSE + 素材路由（双根解析）+ 索引注入
cordis.patch.yml   bundle patch（insert 一行）
注意事项.md         素材供应商必读：GIF 命名必须描述动作本身
web/
  chat-pet.js      套件原件的状态机（改动都在文件里逐条注明）
  glue.js          客户端引导层：造 DOM、订 SSE、驱动 chatPetSync
  pet.css          容器样式（256x256 —— 本套素材 BOX 是正方形）
tools/
  sync-assets.mjs     把 convert_pet 的产物同步成素材布局（含孤儿清理）
  selftest.mjs        宿主侧自检：状态机 + 注入行 + 素材双根解析
  selftest-front.mjs  前端侧自检：清单推導 + 变体轮换 + 预载收敛 + 待机节律（vm + 假时钟）
  check-assets.mjs    对着运行中的宿主全量核销素材 URL
```

**包外（素材根，默认 `<DSH_HOME>/petkit-assets`，可用 `config.assetsDir` 改）**

```
pet/*.webp          157 支动画（源素材见 ../petkit，分桶表见 ../asset-map.json）
pet-manifest.js     素材清单（内容哈希 + 真实时长）；清单是生成物，不入包
```

对套件原件的改动集中在 [chat-pet.js](./web/chat-pet.js) 里，每处都有注释与理由：
`chatPetUrl()` 的可配置基址、变体推導与轮换、`before/loop` 下标配对、缓存键归一、
预载收敛、待机节律（15s 换图 / 5 分钟入睡）。不设任何配置时行为与原件最接近。

## 自检

```powershell
node tools/selftest.mjs          # 宿主侧：状态机 + 注入行 + 素材双根解析
node tools/selftest-front.mjs    # 前端侧：清单/变体/预载/待机节律（vm + 假时钟）
node tools/check-assets.mjs http://127.0.0.1:19387   # 对运行中的宿主全量核销
```

宿主插件是启动时 import 的，改 `index.js` 不会热重载，所以逻辑的正确性必须能在进程外验证。
前两支自检都**不需要 DSH 进程**；`selftest.mjs` 找不到内核包时会跳过 3 项渲染断言
（设 `DSH_CHECKOUT=<内核 node_modules>` 可补上），不会假装通过。

## 踩过的坑（改这个插件前先读）

1. **资产基址与资源路由漂移 = 桌宠完全隐形。** 套件有「首图就位前桌宠不显示」的加载门禁，
   所以素材全 404 的症状不是"图裂了"而是"什么都没有"。自检里专门有一条防漂移断言。
2. **热挂载时看不到 `turn/start`。** 插件是在某个回合中途挂上的，只认 `turn/start`
   会让桌宠整轮都以为自己在空闲。现在任何"属于回合"的事件都隐含该回合是开着的。
3. **别用 `Date.now()` 判事件先后。** 同毫秒内的多个事件会打平，跨会话就会取错桶
   （自检抓到过）。用单调递增序号。
4. **别注册宽前缀路由。** web server 最长前缀优先，宽前缀会把 client-modules 的
   `/plugins/<包>/client.js` 也吃掉，前端 bundle 永远物化不出来。
5. **零外部依赖，且刻意不汇出 `Config`。** `link:` 安装不会装被链接包自身的依赖，
   一旦解析失败整个 profile 起不来；`Config` 需要 `@deepseek-ai/schemastery`，多一条依赖多一个坑。
6. **移除后再挂同一个 bundle 名不会热套用。** 这个版本只认"首次出现的 bundle 名称"；
   改代码后想免重启生效，只能换一个包名（本插件从 `dsh-petkit` 改成 `dsh-petkit-pet` 就是这个原因）。
   客户端文件（`web/*.js`、`web/*.css`）不受此限——它们走 `no-store`，每次请求重读。

## 来源与致谢

| 部分 | 出处 |
|---|---|
| **素材（157 支动画）** | Bilibili《?!🐳蓝色大肥鱼表情包🐳!?》 <https://www.bilibili.com/video/BV1V88G6TEvg> —— 素材作者 **赤风RED** |
| **桌宠的构想与「项目包」** | Bilibili《沉浸式体验哦鲸鲸为自己妆点鲸窝（附项目包）》 <https://www.bilibili.com/video/BV1EqeP6PEmM> |
| 素材转换脚本与前端状态机 | PetKit（`../petkit`）—— `convert_pet.py` / `chat-pet.js` / `pet.css` |

**本插件不是上述任何项目的移植，而是它们的简化版。** 「妆点鲸窝」那套项目包很完整，
但也因此不好装；这里只把**驱动一只桌宠所需的最小部分**抽出来，做成一条命令装完就能用的
DSH 外挂——状态映射 + SSE 推送 + 双根素材路由 + 索引注入，四条就够。
素材与程序分家、行为全部走 `config`，换素材不用碰代码。

素材的命名要求与建议来源见 [注意事项.md](./注意事项.md)。

## 许可与再分发

- 本适配层（`index.js`、`web/glue.js`、`tools/`、文档）：MIT。
- 来自 PetKit 的 `web/chat-pet.js`、`web/pet.css`：MIT（见 `../petkit/README.md`）。
- **素材（`<assetsDir>/pet/*.webp` 与 `pet-manifest.js`）不在 MIT 覆盖范围内**，
  且上游未声明再分发许可。自己用没问题；**要对外分发请先确认原作者（赤风RED）的授权**，
  并保留本节署名。
