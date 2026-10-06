/**
 * petkit 素材 HTTP 核销 —— 把 manifest 里的每一个 URL 都真打一遍。
 *
 * 为什么要有它：素材基址与宿主注册的资源路由前缀曾经漂移过（/petkit/pet/ vs
 * /petkit/web/pet/），症状是「桌宠完全隐形」——套件有「首图就位前不显示」的加载门禁，
 * 所以 404 不会显示成破图，而是什么都不显示。全量打一遍是唯一能立刻抓到这类错的办法。
 *
 * 用法：node tools/check-assets.mjs [base]      默认 http://127.0.0.1:3080
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3080'
const ASSET_BASE = '/petkit/web/pet/'
const CONCURRENCY = 8

// 清单从**服务器**取，而不是读盘：素材清单不入包（程序与素材分家），
// 而且这样才能顺便验证「宿主把清单服务出来了吗」这件事本身。
const mfRes = await fetch(`${BASE}/petkit/web/pet-manifest.js`)
if (!mfRes.ok) {
    console.error(`取不到 ${BASE}/petkit/web/pet-manifest.js（HTTP ${mfRes.status}）`)
    console.error('  素材没同步？node tools/sync-assets.mjs <convert_pet 的输出目录>')
    process.exit(1)
}
const src = await mfRes.text()
const m = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1))
const names = Object.keys(m)
console.log(`manifest ${names.length} 项，基址 ${ASSET_BASE}，目标 ${BASE}`)

const results = []
let cursor = 0
async function worker() {
    while (cursor < names.length) {
        const i = cursor++
        const name = names[i]
        const url = `${BASE}${ASSET_BASE}${name}.webp?v=${m[name].h}`
        const t0 = Date.now()
        try {
            const r = await fetch(url)
            const buf = await r.arrayBuffer()
            results.push({ name, status: r.status, type: r.headers.get('content-type'),
                len: buf.byteLength, ms: Date.now() - t0,
                cache: r.headers.get('cache-control') })
        } catch (err) {
            results.push({ name, status: 0, error: String(err && err.message || err), ms: Date.now() - t0 })
        }
    }
}
const t0 = Date.now()
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
const wall = Date.now() - t0

const bad = results.filter(r => r.status !== 200)
const wrongType = results.filter(r => r.status === 200 && r.type !== 'image/webp')
const noImmutable = results.filter(r => r.status === 200 && !/immutable/.test(r.cache || ''))
const bytes = results.reduce((a, r) => a + (r.len || 0), 0)
const ms = results.map(r => r.ms).sort((a, b) => a - b)

console.log(`\n全部 200: ${bad.length === 0 ? '是' : '否（' + bad.length + ' 个失败）'}`)
if (bad.length) for (const r of bad.slice(0, 10)) console.log(`   ${r.status} ${r.name} ${r.error || ''}`)
console.log(`Content-Type 全是 image/webp: ${wrongType.length === 0 ? '是' : '否（' + wrongType.length + '）'}`)
console.log(`Cache-Control 全带 immutable: ${noImmutable.length === 0 ? '是' : '否（' + noImmutable.length + '）'}`)
console.log(`传输总量 ${(bytes / 1048576).toFixed(1)} MB / 并发 ${CONCURRENCY} / 墙钟 ${wall} ms`)
console.log(`单档延迟 min ${ms[0]} ms · 中位 ${ms[Math.floor(ms.length / 2)]} ms · max ${ms[ms.length - 1]} ms`)
process.exit(bad.length === 0 && wrongType.length === 0 ? 0 : 1)
