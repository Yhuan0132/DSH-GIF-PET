/**
 * petkit 前端自检 —— 不需要浏览器、不需要 DSH 进程。
 *
 * 为什么需要它：变体逻辑（清单推導、轮换、配对、预载收敛）全在 chat-pet.js 里，
 * 而它只在浏览器里跑。用 vm + 最小桩把 manifest 与 chat-pet.js 载进来，
 * 就能在进程外断言这些纯逻辑——这正是「加了素材但清单/命名不对」这类问题
 * 最容易漏掉的地方。
 *
 * 用法：node tools/selftest-front.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const WEB = new URL('../web/', import.meta.url)

/**
 * 素材清单现在**不入包**（程序与素材分家，见 注意事项.md）。
 * 从素材根找，并兼容旧的「清单还在 web/ 里」的安装形态。
 */
function findManifest() {
    const cands = [
        process.env.PETKIT_ASSETS ? join(process.env.PETKIT_ASSETS, 'pet-manifest.js') : null,
        join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'petkit-assets', 'pet-manifest.js'),
        fileURLToPath(new URL('../web/pet-manifest.js', import.meta.url)),
    ].filter(Boolean)
    for (const p of cands) { if (existsSync(p)) { return p } }
    return null
}
const MANIFEST = findManifest()
if (MANIFEST === null) {
    console.error('找不到 pet-manifest.js —— 素材清单不入包，需要先把素材同步过来：')
    console.error('  node tools/sync-assets.mjs <convert_pet 的输出目录>')
    console.error('  （或用 PETKIT_ASSETS 指向素材根）')
    process.exit(2)
}
let pass = 0
const fails = []
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label) }
    else { fails.push(label); console.log('  FAIL ' + label + (detail === undefined ? '' : '   [' + detail + ']')) }
}

// 假时钟 + 假定时器：待机节律（15s 换图 / 5 分钟入睡）必须能在进程外断言，
// 否则只能靠肉眼盯五分钟。chat-pet.js 只用 Date.now()，所以假 Date 足够。
let fakeNow = 1000000
const pending = []
let timerSeq = 0
const RealDate = Date
function FakeDate(...args) { return args.length === 0 ? new RealDate(fakeNow) : new RealDate(...args) }
FakeDate.now = () => fakeNow
FakeDate.prototype = RealDate.prototype
function fireEarliest() {
    if (pending.length === 0) return false
    pending.sort((a, b) => a.at - b.at)
    const t = pending.shift()
    fakeNow = Math.max(fakeNow, t.at)
    t.fn()
    return true
}

const ctx = {
    console,
    window: { chatPetAssetBase: '/petkit/web/pet/' },
    location: { hash: '' },
    Date: FakeDate,
    setTimeout(fn, ms) { const id = ++timerSeq; pending.push({ id, fn, at: fakeNow + (Number(ms) || 0) }); return id },
    clearTimeout(id) { const i = pending.findIndex(t => t.id === id); if (i >= 0) pending.splice(i, 1) },
    setInterval() { return 0 },
}
ctx.globalThis = ctx
vm.createContext(ctx)
vm.runInContext(readFileSync(MANIFEST, 'utf8'), ctx, { filename: MANIFEST })
vm.runInContext(readFileSync(new URL('chat-pet.js', WEB), 'utf8'), ctx, { filename: 'chat-pet.js' })
const ev = (expr) => vm.runInContext(expr, ctx)

const manifestKeys = ev('Object.keys(chatPetManifest)')
const BASES = ['loop-sseErr', 'loop-link', 'loop-wait', 'loop-think', 'loop-tool', 'loop-run',
    'loop-reply', 'before-idle', 'loop-idle', 'loop-idle-hook', 'before-idle-hook',
    'loop-idle-sleep', 'before-idle-sleep', 'after-idle-check']
const EXPECT = {
    'loop-sseErr': 13, 'loop-link': 8, 'loop-wait': 7, 'loop-think': 6, 'loop-tool': 10,
    'loop-run': 11, 'loop-reply': 7, 'before-idle': 6, 'loop-idle': 34,
    'loop-idle-hook': 5, 'before-idle-hook': 0, 'loop-idle-sleep': 4,
    'before-idle-sleep': 1, 'after-idle-check': 45,
}

console.log('A. 清单与变体推導')
check('manifest 非空', manifestKeys.length > 0, String(manifestKeys.length))
check('manifest 键数 = 预期总数', manifestKeys.length === Object.values(EXPECT).reduce((a, b) => a + b, 0),
    manifestKeys.length + ' vs ' + Object.values(EXPECT).reduce((a, b) => a + b, 0))

let allCovered = true
const badKeys = []
for (const k of manifestKeys) {
    const base = k.replace(/-\d+$/, '')
    if (BASES.indexOf(base) < 0) { allCovered = false; badKeys.push(k) }
    // 变体序号必须从 2 起、连续无洞（缺口会让 chatPetVariants 提前停下）
}
check('每个键都属于 14 个契约分组之一（管线与前端一致）', allCovered, badKeys.slice(0, 5).join(','))
check('没有孤立的 loop-idle-1（编号从 -2 起）', manifestKeys.indexOf('loop-idle-1') < 0)

let contiguous = true
const gapDetail = []
for (const base of BASES) {
    const list = ev(`chatPetVariants(${JSON.stringify(base)})`)
    if (list.length !== EXPECT[base]) { contiguous = false; gapDetail.push(base + ':' + list.length + '≠' + EXPECT[base]) }
    if (list.length > 0 && list[0] !== base) { contiguous = false; gapDetail.push(base + ' 首项不是契约原名') }
}
check('各分组变体数与素材一一对应', contiguous, gapDetail.join(' '))

console.log('\nB. 预载收敛（157 张不全预载）')
const order = ev('chatPetLoadOrder()')
check('预载首项是 loop-sseErr（加载门禁靠它）', order[0] === 'loop-sseErr', String(order[0]))
check('预载量远小于全量', order.length > 0 && order.length <= 25, order.length + ' / ' + manifestKeys.length)
check('预载项都在 manifest 里', order.every(n => manifestKeys.indexOf(n) >= 0))
check('预载无重复', new Set(order).size === order.length)
check('全量清单含 14 个分组首项', BASES.every(b => manifestKeys.indexOf(b) >= 0 || EXPECT[b] === 0))

console.log('\nC. 轮换与配对')
const seq = ev(`(function(){var out=[];for(var i=0;i<80;i=i+1){out.push(chatPetPickVariant('loop-idle'));}return out;})()`)
let adjacent = true
for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[i - 1]) { adjacent = false } }
check('待机变体轮换不连续重复（80 次）', adjacent)
check('轮换确实用到多张', new Set(seq).size > 5, String(new Set(seq).size))
check('每次都在清单内', seq.every(n => manifestKeys.indexOf(n) >= 0))

const checkSeq = ev(`(function(){var out=[];for(var i=0;i<60;i=i+1){var idx=chatPetPick(CHAT_PET_CHECKS.length, -1);out.push(CHAT_PET_CHECKS[idx].name);}return out;})()`)
check('点击回应候选数 = after-idle-check 变体数', checkSeq.length === 60 && new Set(checkSeq).size > 20,
    String(new Set(checkSeq).size))

console.log('\nD. URL 与缓存键')
check('基名去后缀', ev(`chatPetBaseName('loop-idle-3')`) === 'loop-idle'
    && ev(`chatPetBaseName('loop-idle')`) === 'loop-idle')
const k1 = ev(`chatPetCacheKey('http://127.0.0.1:3080/petkit/web/pet/loop-idle.webp?v=ab')`)
const k2 = ev(`chatPetCacheKey('/petkit/web/pet/loop-idle.webp?v=ab')`)
check('缓存键对绝对/相对 URL 归一一致', k1 === k2 && k1 === 'pet/loop-idle.webp?v=ab', k1 + ' | ' + k2)
const u = ev(`chatPetUrl('loop-idle-3')`)
check('素材 URL 落在正确基址下', u.indexOf('/petkit/web/pet/loop-idle-3.webp?v=') === 0, u)
check('URL 带内容哈希（缓存失效键）', /\?v=[0-9a-f]{8}$/.test(u), u)

console.log('\nE. 接缝溶解按基名命中')
check('loop-idle-3 视同 loop-idle（走溶解）', ev(`CHAT_PET_SEAM_BLEND[chatPetBaseName('loop-idle-3')]`) === true)
check('loop-tool 不在溶解名单（走瞬切）', ev(`CHAT_PET_SEAM_BLEND[chatPetBaseName('loop-tool')]`) === undefined)

console.log('\nF. 待机节律（每 15s 换图 / 5 分钟才入睡）')
check('换图间隔 = 15s', ev('CHAT_PET_IDLE_ROTATE_MS') === 15000, String(ev('CHAT_PET_IDLE_ROTATE_MS')))
check('入睡阈值 = 5 分钟', ev('CHAT_PET_IDLE_SLEEP_MS') === 300000, String(ev('CHAT_PET_IDLE_SLEEP_MS')))
check('套件原本的 5 秒常量已移除', ev('typeof CHAT_PET_IDLE_BASE_HOLD_MS') === 'undefined')
check('轮换器存在', ev('typeof chatPetIdleRotate') === 'function')

ev("chatPetMode = 'idle'")                       // 直接置空闲态（不经 chatPetSync）
pending.length = 0
ev('chatPetPlayBase(false)')
check('进入待机立刻排了 15s 换图定时器',
    pending.length === 1 && pending[0].at - fakeNow === 15000,
    pending.length + ' 个定时器')

let rotated = 0
const seen = new Set()
for (let i = 0; i < 8; i++) {
    const before = ev('chatPetIdleIdx')
    fireEarliest()
    const after = ev('chatPetIdleIdx')
    seen.add(after)
    if (after !== before) { rotated++ }
}
check('8 轮换图每次都换了一张', rotated === 8, '换了 ' + rotated + ' 次')
check('会在多张之间随机跳（非固定循环）', seen.size >= 4, '用到 ' + seen.size + ' 张')
check('前 2 分钟不会入睡（用户要的就是这个）', ev('chatPetIdleMode') === 'base', ev('chatPetIdleMode'))

let guard = 0
while (ev('chatPetIdleMode') === 'base' && guard < 80) { fireEarliest(); guard++ }
check('5 分钟到点才进入睡觉', ev('chatPetIdleMode') === 'sleep', ev('chatPetIdleMode'))

// 活动重置：重新进入待机要重新给满 5 分钟，而不是接着旧倒计时
ev('chatPetIdleMode = ""')
pending.length = 0
ev('chatPetPlayBase(false)')
check('重新进入待机重新起算 15s',
    pending.length === 1 && pending[0].at - fakeNow === 15000)
check('睡意到点时刻被推到 5 分钟后',
    ev('chatPetIdleSleepAt') - fakeNow === 300000, String(ev('chatPetIdleSleepAt') - fakeNow))

console.log('\n' + (fails.length === 0 ? `PASS — ${pass}/${pass} 项` : `FAIL — ${fails.length} 项未过：${fails.join('; ')}`))
process.exit(fails.length === 0 ? 0 : 1)
