/**
 * petkit 自检 —— 不需要 DSH 进程、不需要重启。
 *
 * 为什么需要它：宿主插件是启动时 import 的，改 index.js 不会热重载。
 * 所以状态机的正确性必须能在进程外验证，而不是靠「重启一次看看」。
 *
 * 覆盖两件事：
 *   A. 状态机：用桩 ctx 喂合成 session/event，断言六个态 + wait + idle 的迁移。
 *   B. 注入行：用**真实的** renderIndexInjections 渲染本插件推的行，断言
 *      只推一条 script 行（不是桌面端会 reject 整个 boot 的 script-src）、
 *      内联文本自成一体（含 CSS 与素材基址）、基址与资源路由不漂移。
 *
 * 用法：node tools/selftest.mjs
 *   DSH_CHECKOUT=<内核 node_modules 绝对路径>  可指定内核包位置（找不到会自动降级跳过 B 的渲染断言）
 */
import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 内核包的位置随安装方式而异（npx 缓存 / 全局 / 桌面端在 app.asar 内不可读），
// 所以按候选列表探测，而不是写死某一台机器的路径。
const CHECKOUTS = [
    process.env.DSH_CHECKOUT,
    'C:/Users/yhuan/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules',
    process.env.npm_config_prefix ? process.env.npm_config_prefix.replace(/\\/g, '/') + '/node_modules' : null,
].filter(Boolean)

async function loadRealRenderer() {
    for (const root of CHECKOUTS) {
        try {
            const m = await import(pathToFileURL(root + '/@deepseek-ai/dsh-host-webserver/lib/index.js').href)
            if (typeof m.renderIndexInjections === 'function') { return m.renderIndexInjections }
        } catch (err) { /* 换下一个候选 */ }
    }
    return null
}

const HERE = new URL('../', import.meta.url)

let pass = 0
const fails = []
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label) }
    else { fails.push(label); console.log('  FAIL ' + label + (detail ? '   [' + detail + ']' : '')) }
}

// ── 桩 ctx ────────────────────────────────────────────────────────────────
function stubCtx() {
    const routes = []
    const listeners = new Map()
    const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        webServer: {
            register(route) { routes.push(route); return () => {} },
        },
        effect(fn) { fn() },
        on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, [])
            listeners.get(event).push(handler)
            return () => {}
        },
        _routes: routes,
        _listeners: listeners,
        _emit(event, ...args) { for (const h of (listeners.get(event) || [])) h(...args) },
    }
    return ctx
}

/** 调 state.json 的 handler，取回状态对象。 */
function readState(ctx) {
    const route = ctx._routes.find(r => r.path === '/petkit/state.json')
    assert.ok(route, 'state.json 路由没注册')
    let body = ''
    route.handler({ url: '/petkit/state.json', on() {} }, {
        writeHead() {},
        end(text) { body = text },
    })
    return JSON.parse(body)
}

const mod = await import(new URL('index.js', HERE).href)
const ctx = stubCtx()
mod.apply(ctx, {})

console.log('A. 状态机（合成 session/event）')
const SID = 's1'
const ev = (type, data = {}) => ({ type, data })
const emit = (type, data) => ctx._emit('session/event', { id: SID }, ev(type, data))

check('初始 = 空闲', readState(ctx).state === '', readState(ctx).state)

// 热挂载自愈：没有 turn/start，直接来一个 step/start 也必须认
emit('step/start', { turn: 1, step: 1 })
check('漏掉 turn/start 时 step/start 仍进入 think', readState(ctx).state === 'think', readState(ctx).state)

emit('tool/call', { name: 'read' })
check('tool/call → tool', readState(ctx).state === 'tool', readState(ctx).state)

emit('tool/result', {})
check('tool/result → think', readState(ctx).state === 'think', readState(ctx).state)

emit('assistant/message', { message: {} })
check('assistant/message → reply', readState(ctx).state === 'reply', readState(ctx).state)

emit('tool/call', { name: 'ask_user_question' })
check('ask_user_question → wait', readState(ctx).state === 'wait', readState(ctx).state)

emit('tool/result', {})
check('回答到达 → 离开 wait', readState(ctx).state === 'think', readState(ctx).state)

emit('approval/asked', { id: 'ap1' })
check('approval/asked → wait', readState(ctx).state === 'wait', readState(ctx).state)

emit('approval/decided', { id: 'ap1' })
check('approval/decided → 离开 wait', readState(ctx).state !== 'wait', readState(ctx).state)

emit('command/run', {})
check('command/run → run', readState(ctx).state === 'run', readState(ctx).state)

emit('tool-workflow/run-start', {})
check('工作流开始后仍是 run', readState(ctx).state === 'run', readState(ctx).state)

emit('turn/end', {})
check('turn/end → 空闲', readState(ctx).state === '', readState(ctx).state)

// 多会话：忙碌的那个说了算
emit('turn/start', { turn: 2 })
ctx._emit('session/event', { id: 's2' }, ev('tool/call', { name: 'bash' }))
check('跨会话取最近活跃（s2 的 tool 胜过 s1 的 think）', readState(ctx).state === 'tool', readState(ctx).state)

// 「有挂起」压过「有会话在跑」——桌宠该先提醒你去回答，而不是安静地演工具态
emit('tool/call', { name: 'ask_user_question' })
check('挂起提问优先于其它会话的活跃态', readState(ctx).state === 'wait', readState(ctx).state)
emit('tool/result', {})
// 规则是「最近活跃的那个会话说了算」：s1 刚收到 tool/result，它就是最近活跃的，
// 所以此刻该显示 s1 的 think，而不是 s2 稍早的 tool。
check('解除后由最近活跃决定（s1 刚动过 → think）', readState(ctx).state === 'think', readState(ctx).state)
ctx._emit('session/event', { id: 's2' }, ev('tool/call', { name: 'bash' }))
check('s2 再动一次 → 又回到 s2 的 tool', readState(ctx).state === 'tool', readState(ctx).state)

ctx._emit('session/disposed', { id: 's2' })
check('会话销毁后回落', readState(ctx).state === 'think', readState(ctx).state)

console.log('\nB. 注入行')
const renderIndexInjections = await loadRealRenderer()
if (renderIndexInjections === null) {
    console.log('  ---- 找不到内核的 dsh-host-webserver，跳过「用真实渲染器渲染」的 3 项；')
    console.log('       其余断言照跑。设 DSH_CHECKOUT=<内核 node_modules 绝对路径> 可补上。')
}
const table = []
ctx._emit('webserver/index-inject', table)
check('只推 1 行（自包含内联脚本）', table.length === 1, '实际 ' + table.length)
// 桌面端的页面侧解释器对 script-src 是「加载失败即 reject 整个 boot」。
// 桌宠是装饰品，绝不该有能力把宿主启动搞挂——所以这条断言是硬约束。
check('行种类是 script，不是 script-src', table[0].kind === 'script', table[0].kind)
check('放在 body', table[0].placement === 'body', table[0].placement)
const text = String(table[0].text || '')
check('内联文本不含 </script（否则提前闭合元素）', !/<\/script/i.test(text))
check('内联文本不出现 script-src', text.indexOf('script-src') < 0)
check('三个档名齐备且顺序正确',
    text.indexOf('pet-manifest.js') >= 0
    && text.indexOf('pet-manifest.js') < text.indexOf('chat-pet.js')
    && text.indexOf('chat-pet.js') < text.indexOf('glue.js'))
check('内联文本自带 pet.css 内容（不依赖 style 行）', text.indexOf('#chatPet') >= 0)
check('内联文本自带基址赋值（不依赖 global 行）', text.indexOf('chatPetAssetBase') >= 0)

// 漂移守卫：内联脚本里写死的基址必须落在**已注册的资源路由**之内。
// 第一版就是这两者漂移了（/petkit/pet/ vs /petkit/web/pet/），
// 后果不是 404 日志那么轻——套件「首图就位前不显示」的门禁让桌宠**完全隐形**。
const assetRoute = ctx._routes.find(r => r.kind === 'prefix' && r.path === '/petkit/web')
const mBase = text.match(/var base="([^"]+)"/)
const assetBase = (mBase ? mBase[1] : '') + 'pet/'
check('资源路由已注册', assetRoute !== undefined)
check('素材基址落在资源路由之内（防漂移）',
    assetRoute !== undefined && assetBase.startsWith(assetRoute.path + '/'),
    'assetBase=' + assetBase + ' route=' + (assetRoute && assetRoute.path))
check('素材基址 = /petkit/web/pet/', assetBase === '/petkit/web/pet/', assetBase)

if (renderIndexInjections !== null) {
    const html = renderIndexInjections('<html><head></head><body></body></html>', table)
    check('渲染后落在 body 内', html.indexOf('chatPetAssetBase') > html.indexOf('<body'))
    check('渲染结果含三个档名', ['pet-manifest.js', 'chat-pet.js', 'glue.js'].every(s => html.includes(s)))
    // 注意：renderIndexInjections 自己会在末尾渲染一段 boot-readiness tail（内含 <script>），
    // 所以不能直接数绝对个数——要比对「空表 vs 本插件的行」的差值。
    const countScripts = (s) => (s.match(/<script/gi) || []).length
    const emptyHtml = renderIndexInjections('<html><head></head><body></body></html>', [])
    check('注入只新增一个 script 元素（自带 tail 不计）',
        countScripts(html) - countScripts(emptyHtml) === 1,
        `空=${countScripts(emptyHtml)} 有=${countScripts(html)}`)
}

console.log('\nC. 素材路由解析（程序根 / 素材根 双根）')
async function get(path) {
    let code = 0, type = '', cache = '', len = 0
    await assetRoute.handler({ url: path, method: 'GET' }, {
        writeHead(c, h) {
            code = c
            type = String((h && h['Content-Type']) || '')
            cache = String((h && h['Cache-Control']) || '')
        },
        end(b) { len = b !== undefined && b !== null ? b.length : 0 },
    })
    return { code, type, cache, len }
}
const glueRes = await get('/petkit/web/glue.js')
check('程序根的文件能取到（glue.js，包内）',
    glueRes.code === 200 && glueRes.type.indexOf('javascript') >= 0, glueRes.code + ' ' + glueRes.type)
check('程序文件用 no-store（改了刷新即生效）', glueRes.cache.indexOf('no-store') >= 0, glueRes.cache)

// 素材根默认在 <DSH_HOME>/petkit-assets。同步过才做素材侧断言——
// 全新安装时素材本来就该是空的（素材不入包），那不是失败。
const assetsManifest = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'petkit-assets', 'pet-manifest.js')
if (existsSync(assetsManifest)) {
    const mfText = readFileSync(assetsManifest, 'utf8')
    const mfJson = JSON.parse(mfText.slice(mfText.indexOf('{'), mfText.lastIndexOf('}') + 1))
    const firstName = Object.keys(mfJson)[0]
    const mf = await get('/petkit/web/pet-manifest.js')
    check('素材根的文件能取到（pet-manifest.js，包外）', mf.code === 200 && mf.len > 0, mf.code + ' ' + mf.len + 'B')
    check('清单用 no-store（它是缓存失效键的来源）', mf.cache.indexOf('no-store') >= 0, mf.cache)
    const one = await get('/petkit/web/pet/' + firstName + '.webp')
    check('素材根的动画能取到（' + firstName + '.webp）',
        one.code === 200 && one.type === 'image/webp' && one.len > 0, one.code + ' ' + one.type)
    check('动画用 immutable（URL 带内容哈希，可长缓存）', one.cache.indexOf('immutable') >= 0, one.cache)
} else {
    console.log('  ---- 素材根还没同步内容（' + assetsManifest + '），跳过素材侧 4 项')
    console.log('       node tools/sync-assets.mjs <convert_pet 的输出目录>')
}
check('目录穿越被挡（../）', (await get('/petkit/web/../package.json')).code === 404)
check('不存在的素材回 404', (await get('/petkit/web/pet/nope.webp')).code === 404)
check('非白名单扩展名被挡（.md）', (await get('/petkit/web/../../README.md')).code === 404)

console.log('\n' + (fails.length === 0 ? `PASS — ${pass}/${pass} 项` : `FAIL — ${fails.length} 项未过：${fails.join('; ')}`))
process.exit(fails.length === 0 ? 0 : 1)
