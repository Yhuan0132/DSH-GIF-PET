/**
 * sync-assets —— 把 PetKit 的转换产物同步成插件要的素材布局。
 *
 * 为什么要这一步：程序与素材分家（包只有几十 KB，素材百 MB 级且因人而异），
 * 但两边的目录形状不一样：
 *
 *   convert_pet.py 产出         插件要的（<assetsDir>）
 *   ─────────────────────       ─────────────────────
 *   <out>/pet/*.webp            pet/*.webp
 *   <out>/js/pet-manifest.js    pet-manifest.js
 *
 * 同时做**孤儿清理**：素材根里存在、来源已经没有的 webp 会被删掉。
 * 不清理的话改过素材池之后，旧文件会继续出现在 manifest 里、前端会以为那一组还有图
 * （本项目实测过：改了分桶后 manifest 多出一项 before-idle-hook——同一类坑在
 *   dsh-boot-animation 是 faststart 副本被当成第二条片段）。
 *
 * 用法：
 *   node tools/sync-assets.mjs <convert_pet 的输出目录> [assetsDir]
 *   node tools/sync-assets.mjs E:\deepseek\desktop-pet\out\html
 *   node tools/sync-assets.mjs E:\...\out\html D:\my-pet-assets
 *
 * assetsDir 省略时与 index.js 的默认值一致：<DSH_HOME>/petkit-assets
 */
import { readFileSync, readdirSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const dryRun = process.argv.includes('--dry-run')

if (args.length === 0) {
    console.error('用法: node tools/sync-assets.mjs <convert_pet 的输出目录> [assetsDir]')
    process.exit(1)
}

const SRC = resolve(args[0])
const ASSETS = args[1]
    ? resolve(args[1])
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'petkit-assets')

const SRC_PET = join(SRC, 'pet')
const SRC_MANIFEST = join(SRC, 'js', 'pet-manifest.js')
const DST_PET = join(ASSETS, 'pet')

const problems = []
if (!existsSync(SRC_PET)) problems.push('来源里没有 pet/ 目录：' + SRC_PET)
if (!existsSync(SRC_MANIFEST)) problems.push('来源里没有 js/pet-manifest.js：' + SRC_MANIFEST)
if (problems.length > 0) {
    for (const p of problems) console.error('  ✘ ' + p)
    console.error('  （先跑 PetKit 的 convert_pet.py 生成产物；素材命名要求见 注意事项.md）')
    process.exit(1)
}

console.log('来源 : ' + SRC)
console.log('素材根: ' + ASSETS)
if (dryRun) console.log('（--dry-run：只看不写）')

const srcFiles = readdirSync(SRC_PET).filter(f => f.toLowerCase().endsWith('.webp'))
const manifest = readFileSync(SRC_MANIFEST, 'utf8')
const declared = new Set(Object.keys(JSON.parse(manifest.slice(manifest.indexOf('{'), manifest.lastIndexOf('}') + 1))))

if (!dryRun) mkdirSync(DST_PET, { recursive: true })
const dstFiles = existsSync(DST_PET) ? readdirSync(DST_PET).filter(f => f.toLowerCase().endsWith('.webp')) : []

// 孤儿清理：素材根里有、来源里没有的
const orphans = dstFiles.filter(f => srcFiles.indexOf(f) < 0)
for (const f of orphans) {
    if (!dryRun) rmSync(join(DST_PET, f), { force: true })
    console.log('  删孤儿 ' + f)
}

let copied = 0
for (const f of srcFiles) {
    if (!dryRun) copyFileSync(join(SRC_PET, f), join(DST_PET, f))
    copied++
}
if (!dryRun) copyFileSync(SRC_MANIFEST, join(ASSETS, 'pet-manifest.js'))

// 一致性：清单里声明的每一支都必须真的有文件（缺了那一组会回落到网络路径）
const missing = [...declared].filter(n => srcFiles.indexOf(n + '.webp') < 0)
const extra = srcFiles.filter(f => !declared.has(basename(f, '.webp')))

const bytes = srcFiles.reduce((a, f) => a + statSync(join(SRC_PET, f)).size, 0)
console.log('')
console.log(`同步 ${copied} 支 webp（${(bytes / 1048576).toFixed(1)} MB） + pet-manifest.js（${declared.size} 项）`)
console.log(`孤儿清理 ${orphans.length} 个`)
if (missing.length) console.log(`⚠ 清单里有但缺文件（${missing.length}）：${missing.slice(0, 6).join(', ')}`)
if (extra.length) console.log(`⚠ 有文件但清单没声明（${extra.length}）：${extra.slice(0, 6).join(', ')}`)
if (missing.length === 0 && extra.length === 0) console.log('清单与文件一一对应 ✔')
process.exit(missing.length === 0 ? 0 : 1)
