/**
 * dsh-petkit —— 把 PetKit 桌宠（蓝色大肥鱼）挂进 DSH Web GUI，
 * 并让它跟着 agent 的真实运行态动：
 *
 *   think   → 正在思考      tool → 调工具        reply → 生成回复
 *   run     → 跑工作流/命令  wait → 等你回答或授权
 *   link    → SSE 连接中     sseErr → 断线       idle → 空闲（含摸头/入睡/移入）
 *
 * ── 设计要点（每一条都是这个环境里踩出来的）─────────────────────────────
 * 1. **零外部依赖**：只用 node 内置模块。`link:` 安装不会装被链接包自身的依赖，
 *    一旦 import 解析失败，整个 profile 会起不来（dsh-pet-indesktop PR #104 的事故）。
 * 2. **不汇出 Config**：那需要 `@deepseek-ai/schemastery`，多一条依赖就多一个坑
 *    （dsh-boot-animation 为此专门写过一节）。本插件不需要设置面板。
 * 3. **路由放在 /petkit 下，不用宽前缀**：web server 最长前缀优先，宽前缀会把
 *    client-modules 的 `/plugins/<包>/client.js` 也吃掉（dsh-boot-animation 作者的注释）。
 * 4. **状态来自宿主权威事件流** `ctx.on('session/event')`，不是前端猜的。
 *    事件词表见 `@deepseek-ai/dsh-session` 的 known-event-types。
 * 5. **推送给前端用 SSE**：webserver 的 route handler 文档明写
 *    "may hold the response open, e.g. SSE"。
 * 6. **素材 URL 带内容哈希**（源自 pet-manifest.js），故 webp 可以 immutable；
 *    但 manifest 本身必须 no-store —— 它是缓存失效键的来源。
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep, extname } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 程序根：随包发布（chat-pet.js / glue.js / pet.css）。 */
const WEB = join(HERE, 'web')
const ROUTE = '/petkit'
/**
 * 素材根：**不入包**。
 * 157 支 webp 是从 GIF 转出来的大文件（百 MB 级），而且每套 GIF 都不一样，
 * 所以程序与素材分家：包只有几十 KB，素材放 DSH_HOME 下、可用 config.assetsDir 指到别处。
 * 布局：<assetsDir>/pet/*.webp 与 <assetsDir>/pet-manifest.js
 */
const DEFAULT_ASSETS_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'petkit-assets')

/** 挂起提问的工具名——`ask_user_question` 是一次**挂起**的工具调用，不是一条独立事件。 */
const WAIT_QUESTION_TOOL = 'ask_user_question'
/** 僵尸回合兜底：事件流断了（宿主崩溃等）也不让桌宠永远卡在忙碌态。 */
const STALE_MS = 2 * 60 * 60 * 1000

export const name = 'petkit'
export const inject = ['webServer']

export function apply(ctx, config) {
    const cfg = config || {}
    const log = (msg, err) => {
        if (err) ctx.logger?.warn?.(`petkit: ${msg}`, err)
        else ctx.logger?.warn?.(`petkit: ${msg}`)
    }

    if (cfg.enabled === false) {
        ctx.logger?.info?.('petkit: 已按配置停用（config.enabled === false）')
        return
    }
    if (!existsSync(join(WEB, 'chat-pet.js'))) {
        log(`web/ 资源缺失：${WEB}（插件不会注入任何东西）`)
        return
    }

    // ───────────────────────── 状态跟踪 ─────────────────────────
    /** 每会话一个桶；跨会话取「最近有动静的那个活跃桶」。 */
    const sessions = new Map()
    /**
     * 单调递增序号——判定「哪个会话最近有动静」用它，不用墙上时钟：
     * 同一毫秒内的多个事件用 Date.now() 会打平，跨会话就会取错桶
     * （自检 tools/selftest.mjs 抓到过这一条）。
     */
    let SEQ = 0

    function bucket(sid) {
        let b = sessions.get(sid)
        if (b === undefined) {
            b = { sid, open: false, phase: '', tool: null, ask: null, ms: 0, seq: 0 }
            sessions.set(sid, b)
        }
        return b
    }

    /** callId 在 payload 里的位置随事件类型而变；取不到时用兜底 id（挂起期不会有别的 tool/result）。 */
    function callId(event) {
        try {
            const d = event.data || {}
            const msg = d.message
            const list = Array.isArray(d.content) ? d.content : []
            for (const c of list) {
                if (c && (c.toolCallId || c.tool_call_id)) return String(c.toolCallId || c.tool_call_id)
            }
            if (msg && (msg.callId || msg.toolCallId || msg.tool_call_id)) {
                return String(msg.callId || msg.toolCallId || msg.tool_call_id)
            }
            return String(d.callId || d.call_id || d.toolCallId || d.tool_name || '')
        } catch (err) {
            return ''
        }
    }

    /**
     * 「属于某个回合」的事件——收到即视为该回合处于开放状态。
     * 这不是洁癖：插件热挂载时，当前回合的 `turn/start` 早就过去了，
     * 只认 turn/start 会让桌宠在整轮里都以为自己空闲（本插件第一版就这么错了）。
     */
    const IN_TURN = new Set([
        'step/start', 'step/end', 'assistant/message', 'assistant/attempt',
        'tool/call', 'tool/result', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
        'command/run', 'command/done',
        'tool-workflow/run-start', 'tool-workflow/run-end',
        'approval/asked', 'approval/decided',
        'llm/retry', 'llm/retry-started',
    ])

    function onSessionEvent(session, event) {
        try {
            const sid = (session && session.id) || 'default'
            const b = bucket(sid)
            const type = String((event && event.type) || '')
            const data = (event && event.data) || {}
            b.ms = Date.now()
            b.seq = ++SEQ
            if (IN_TURN.has(type)) b.open = true

            switch (type) {
                case 'turn/start':
                    b.open = true; b.phase = 'think'; b.tool = null; b.ask = null
                    break
                case 'step/start':
                    b.phase = 'think'
                    break
                case 'assistant/message':
                    b.phase = 'reply'
                    break
                case 'tool/call': {
                    const nm = String(data.name || data.toolName || '')
                    if (nm === WAIT_QUESTION_TOOL) {
                        b.ask = callId(event) || ('q' + b.ms)
                        b.phase = 'wait'
                    } else {
                        b.tool = callId(event) || ('t' + b.ms)
                        b.phase = 'tool'
                    }
                    break
                }
                case 'tool/result': {
                    if (b.ask !== null) {
                        const cid = callId(event)
                        if (!cid || cid === b.ask) b.ask = null
                    }
                    b.tool = null
                    if (b.open) b.phase = 'think'
                    break
                }
                case 'approval/asked':
                    b.ask = String(data.id || ('a' + b.ms))
                    b.phase = 'wait'
                    break
                case 'command/run':
                case 'tool-workflow/run-start':
                case 'tool/ptc-dispatch-start':
                    b.phase = 'run'
                    break
                case 'command/done':
                case 'tool-workflow/run-end':
                    if (b.open) b.phase = 'think'
                    break
                case 'turn/end':
                    b.open = false; b.phase = ''; b.tool = null; b.ask = null
                    break
                default:
                    // 除 approval/asked 之外的 approval/* 一律视为「决定的到达」→ 解除挂起
                    if (type.indexOf('approval/') === 0 && b.ask !== null) {
                        const id = String(data.id || '')
                        if (!id || id === b.ask) {
                            b.ask = null
                            if (b.open) b.phase = 'think'
                        }
                    }
                    break
            }
        } catch (err) {
            log('session/event 处理异常（已忽略，不影响宿主）', err)
        }
        broadcast()
    }

    /**
     * 跨会话汇总。两条规则，顺序有意义：
     *   1. 任何会话有挂起的提问/审批 → wait。这是**注意力信号**：
     *      哪怕你在别的会话里，桌宠也该先告诉你「有东西在等你回答」。
     *   2. 否则取最近活跃的开放回合的 phase；都不活跃 = 空闲。
     */
    function globalState() {
        const now = Date.now()
        let waiting = null
        let best = null
        for (const b of sessions.values()) {
            if (b.open && now - b.ms > STALE_MS) { b.open = false; b.phase = ''; b.ask = null }
            if (b.ask !== null && (waiting === null || b.seq > waiting.seq)) waiting = b
            if (!b.open) continue
            if (best === null || b.seq > best.seq) best = b
        }
        if (waiting !== null) return 'wait'
        if (best === null) return ''
        return best.phase || 'think'
    }

    // 订阅宿主权威事件流（ctx.on 已返回由 fiber 托管的 disposer，不需要再包 effect）
    ctx.on('session/event', onSessionEvent)
    ctx.on('session/disposed', (session) => {
        if (session && session.id) sessions.delete(session.id)
    })

    // ───────────────────────── SSE 推送 ─────────────────────────
    const streams = new Set()

    function payload() {
        return `data: ${JSON.stringify({ state: globalState(), ts: Date.now() })}\n\n`
    }

    function broadcast() {
        if (streams.size === 0) return
        const chunk = payload()
        for (const res of streams) {
            try { res.write(chunk) } catch (err) { streams.delete(res) }
        }
    }

    function sseHandler(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        })
        res.write(': petkit stream open\n\n')
        res.write(payload())
        streams.add(res)

        const hb = setInterval(() => {
            try { res.write(': ping\n\n') } catch (err) { /* 关闭时由 close 收拾 */ }
        }, 15000)
        if (typeof hb.unref === 'function') hb.unref()

        const bye = () => {
            clearInterval(hb)
            streams.delete(res)
        }
        req.on('close', bye)
        req.on('error', bye)
        res.on('error', bye)
    }

    // ───────────────────────── 静态资源 ─────────────────────────
    const MIME = {
        '.webp': 'image/webp',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
    }
    const PREFIX = `${ROUTE}/web`

    // 解析顺序：程序根（包内）优先，再落到素材根（包外）。
    // 保留「程序根优先」是为了兼容旧版「素材也在包里」的安装形态。
    const ASSETS = (typeof cfg.assetsDir === 'string' && cfg.assetsDir.trim() !== '')
        ? resolve(cfg.assetsDir) : DEFAULT_ASSETS_DIR
    const ROOTS = [WEB, ASSETS]

    function resolveAsset(url) {
        try {
            const pathname = decodeURIComponent(String(url || '').split('?')[0])
            if (!pathname.startsWith(`${PREFIX}/`)) return null
            const rel = pathname.slice(PREFIX.length + 1)
            if (rel === '') return null
            const ext = extname(rel).toLowerCase()
            if (MIME[ext] === undefined) return null
            for (const root of ROOTS) {
                const abs = resolve(root, rel)
                // 目录穿越防护：解析后必须仍在各自的根之内
                if (abs !== root && !abs.startsWith(root + sep)) continue
                if (existsSync(abs)) return { abs, ext, root }
            }
            return null
        } catch (err) {
            return null
        }
    }

    const sendJson = (res, code, body) => {
        const text = JSON.stringify(body)
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(text),
        })
        res.end(text)
    }

    const server = ctx.webServer

    // 状态快照——给 curl 验证与前端兜底用
    ctx.effect(() => server.register({
        kind: 'exact',
        path: `${ROUTE}/state.json`,
        handler: (req, res) => {
            sendJson(res, 200, {
                ok: true,
                state: globalState(),
                sessions: [...sessions.values()].map(b => ({
                    sid: b.sid, open: b.open, phase: b.phase, ask: b.ask, ageMs: Date.now() - b.ms,
                })),
            })
        },
    }), 'petkit: state route')

    // SSE 状态流
    ctx.effect(() => server.register({
        kind: 'exact',
        path: `${ROUTE}/events`,
        handler: sseHandler,
    }), 'petkit: sse route')

    // 素材与前端脚本
    ctx.effect(() => server.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
            const hit = resolveAsset(req.url)
            if (hit === null) { sendJson(res, 404, { error: 'not found' }); return }
            let bytes
            try {
                bytes = readFileSync(hit.abs)
            } catch (err) {
                sendJson(res, 404, { error: 'not found' })
                return
            }
            // webp 的 URL 带内容哈希（pet-manifest 的 h）→ 可以 immutable；
            // js/css/manifest 必须 no-store：manifest 是缓存失效键的来源。
            const immutable = hit.ext === '.webp'
            res.writeHead(200, {
                'Content-Type': MIME[hit.ext],
                'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
                'Content-Length': bytes.length,
            })
            res.end(bytes)
        },
    }), 'petkit: asset route')

    // ───────────────────────── 索引注入 ─────────────────────────
    ctx.on('webserver/index-inject', (table) => {
        let css
        try {
            css = readFileSync(join(WEB, 'pet.css'), 'utf8')
        } catch (err) {
            log('读不到 web/pet.css，跳过注入', err)
            return
        }
        // 配置可覆盖落点，不用改 CSS 文件
        const extra = []
        if (cfg.right !== undefined) extra.push(`right:${Number(cfg.right)}px`)
        if (cfg.bottom !== undefined) extra.push(`bottom:${Number(cfg.bottom)}px`)
        if (cfg.zIndex !== undefined) extra.push(`z-index:${Number(cfg.zIndex)}`)
        if (extra.length > 0) css += `\n#chatPet{${extra.join(';')}}\n`

        // ⚠️ 一条硬约束（桌面端）：**不能用 `script-src` 行**。
        // 桌面壳的页面侧解释器对 `script-src` 是「加载失败即 reject 整个 boot」——
        // dsh-whale-widget 的作者为此把注入行改成「内联 script 行，由脚本自己建
        // <script src=…> 并吞掉 onerror」（issue #154：一个插件把整个桌面端启动搞挂）。
        // 桌宠是装饰品，任何失败都只该导致「桌宠不出现」，绝不该拖垮宿主启动。
        //
        // 所以只推一条**自包含的内联脚本**，它自己负责：
        //   ① 把 pet.css 作为 <style> 塞进 head（不依赖 style 行——桌面端支持哪些行种类未知）
        //   ② 设 window.chatPetAssetBase（不依赖 global 行，同上）
        //   ③ 按序动态插入三支脚本；单支失败只吞掉，并继续尝试下一支
        const boot = '(function(){try{'
            + `var base=${JSON.stringify(PREFIX + '/')};`
            + `var css=${JSON.stringify(css)};`
            + "window.chatPetAssetBase=base+'pet/';"
            + "var st=document.createElement('style');st.id='petkit-css';st.textContent=css;"
            + "(document.head||document.documentElement).appendChild(st);"
            + "var fs=['pet-manifest.js','chat-pet.js','glue.js'];"
            + "(function next(i){if(i>=fs.length)return;"
            + "var s=document.createElement('script');s.src=base+fs[i];s.async=false;"
            + "s.onerror=function(){next(i+1)};s.onload=function(){next(i+1)};"
            + "(document.body||document.documentElement).appendChild(s);})(0);"
            + '}catch(e){}})();'

        // 行文本里绝不能出现 `</script`（会提前闭合元素）。CSS 是用户可编辑的，
        // 所以对最终文本统一转义一次——JS 字符串里的 `<\/script` 等价于 `</script`。
        table.push({ kind: 'script', placement: 'body', text: boot.replace(/<\/script/gi, '<\\/script') })
    })

    ctx.logger?.info?.(`petkit: 已挂载（状态 /${ROUTE.slice(1)}/state.json · 流 ${ROUTE}/events · 素材 ${PREFIX}/ · 素材根 ${ASSETS}）`)
    if (!existsSync(join(ASSETS, 'pet-manifest.js'))) {
        log('素材根里没有 pet-manifest.js：' + ASSETS
            + '  —— 需要 <assetsDir>/pet/*.webp 与 <assetsDir>/pet-manifest.js'
            + '（由 PetKit 的 convert_pet.py 产出，再用 tools/sync-assets.mjs 同步过来）。'
            + '缺了它素材会全部 404，桌宠不会出现。')
    }
}
