// CH4 外观层——chat-pet.js：桌宠渲染（纯前端；对话页的组成部分）
// 定位：读后端权威运行态（chatRunState——六态）→ 态映射动画资源 → 调度空闲行为与交互反应
// 数据源：chat-core.js 的 chatRunState（经 chatRenderStatus 汇聚点回调）；SSE 断线由引导层 onerror/onopen 置位
// 铁律：前端零业务逻辑——本模块只做「态 / 交互 → 资源」映射与动画调度，不产生业务事件、不介入会话状态机
// 资源：html/pet/*.webp（286x256 原尺寸 1:1 显示 · 20ms/帧 · 透明底 · 圆角矩形边缘羽化；源素材 Workspace/pet/*.gif）
//
// 形态语义（素材约定）：
//   loop-*  循环态（link/wait/think/tool/run/reply/sseErr/idle/idle-hook/idle-sleep）
//   before-* 过渡动画（播一遍）——before-idle-hook 移入 / before-idle-sleep 入睡
//            · before-idle 实为 **after-reply 语义**（整轮结束的收尾动作）——只在「活跃态 → 空闲」时播一次
//            · before-tool 已废弃——素材姿态与 loop-tool 对不齐，进工具态直接切循环图
//   after-*  后置反应（播一遍）——after-idle-check 点击后的摸头反应
// 空闲节律（莎 2026-09-16 定）：进空闲随机一张基础待机播 8s → 直接进入睡；hook/check 结束后同样回到这个 8s 周期
// 渐隐规则（莎 2026-09-16 定）：before → loop、loop → after 两段是连续动作——**瞬切**；其余切换走 0.25s 交叉溶解
// 最短驻留（莎 2026-09-18 定）：tool / run 两态至少播满「≥2s 的真实循环整数倍」（实测 320ms × 7 = 2.24s）——
//   极短态直接连着播会闪断，衔接违和；驻留期内真实态变化只记一笔，期满按**当前真实态**跳转（中间态不补播，
//   最多滞后一个驻留周期）；断线态优先让位
// 素材加载（莎 2026-09-17 定）：初始化即串行加载 → blob 持有 + Cache API 缓存（UI 版本键——版本变即失效）
//   · 加载门禁——首图 loop-sseErr 就位前桌宠不启动（保持不可见，不挂破图）；就位后常显该图作加载态；全量就绪才开放调度
//   · blob 持有 = 断线（宿主不可达）时零网络依赖；缓存 = 刷新不重下（限带宽/穿透场景关键）
//   · 缓存失效键 = 每张素材的内容哈希（js/pet-manifest.js）——改图/改名只重下变动那一张，与代码版本无关
//   · 硬保底——右上角「清理缓存」按钮主动清桶（脏数据 / 改图不改名时用）
//   · 播放时长 = manifest 单一真相（免前端常量与素材漂移）；接缝溶解名单盖住姿态不接的 before→loop 对

// [段1] 状态与常量
var chatPetImgs = [null, null];   // 双层图片元素（交叉溶解——交替作为当前层）
var chatPetLayer = 0;             // 当前显示层下标
var chatPetCur = '';              // 当前资源名（不含扩展名）——同值不切换（防重复溶解）
var chatPetDrag = null;           // 拖动状态 {dx, dy, x0, y0}——null = 未按下
var chatPetDragMoved = false;     // 本次按下是否发生位移（决定随后 click 是否算摸头）
var chatPetOffline = false;       // SSE 断线标记（引导层 onerror/onopen 置位）
var chatPetMode = '';             // 调度模式：run（活跃态）/ idle（空闲）/ offline
var chatPetKey = '';              // 当前态 key（六态名 / idle / offline）
var chatPetKeyAt = 0;             // 进入当前态的时间戳——桌宠自算停留时长（前端调度口径，非展示口径）
var chatPetTimer = null;          // 显示调度定时器（单一定时器——任何切换先清）
var chatPetIdleMode = '';         // 空闲子模式：intro / base / hook / check / sleep
var chatPetIdleIdx = -1;          // 上次基础待机下标（避免连续重复）
var chatPetCheckIdx = -1;         // 上次摸头反应下标（避免连续重复）
var chatPetHovered = false;       // 鼠标是否停留在桌宠上（决定反应结束后回哪个子模式）
var chatPetLastInstant = false;   // 上一次换图是否为瞬切（before→loop / loop→after）——调度与诊断用
var chatPetDwellActive = false;   // 最短驻留期内（tool / run——极短态不闪现）
var chatPetDwellPend = false;     // 驻留期内真实态有变化（期满按当前真实态跳转）
var chatPetDwellTimer = null;     // 驻留定时器（独立于显示调度定时器——语义不同，不共用）
var chatPetRes = {};              // 素材持有表（名称 → blob URL）——串行加载逐张填入；有值则断线时零网络依赖
var chatPetLoading = true;        // 加载门禁——true 期间不开放调度（不响应态变化，不跑空闲节律）
var chatPetBooted = false;        // 首图（loop-sseErr）是否已就位——未就位桌宠保持不可见
var chatPetFail = 0;              // 加载失败计数——全量结束后汇总告警（不静默）
var CHAT_PET_CACHE_PREFIX = 'ch4-pet';    // Cache API 桶名（固定——失效靠逐张 URL 的内容哈希，不靠换桶名）
var chatPetManifest = (typeof chatPetManifestData !== 'undefined') ? chatPetManifestData : {};   // 素材清单（名称 → {h:内容哈希, ms:总时长}）——来自 js/pet-manifest.js；缺失降级空表
// 接缝溶解名单——before 末帧与 loop 首帧姿态不接的对，强制走溶解盖接缝（实测最优截断改善 <10%，裁切无用）
// · loop-idle——before-idle 收尾动作的落点（素材 2026-09-17 由三张合并为一张），姿态不保证对齐，故走溶解
// · before-tool 已废弃（素材删除，进 tool 态直切 loop-tool，无接缝）；其余对仍走瞬切
var CHAT_PET_SEAM_BLEND = {
    'loop-idle-sleep': true, 'loop-idle-hook': true, 'loop-idle': true
};

// 六态 → 循环资源（这里是**分组基名**，具体变体由 chatPetPickVariant 挑）
var chatPetPhaseMap = { link: 'loop-link', wait: 'loop-wait', think: 'loop-think', tool: 'loop-tool', run: 'loop-run', reply: 'loop-reply' };

// ── 变体支持（DSH 适配层加的；套件原本每个态只有一张素材）──────────────────
// 允许 <基名>-2 / -3 …… 多张变体，清单直接从 manifest 推導：
// manifest 是 convert_pet.py 扫描 pet/ 目录生成的，所以加素材永远不用改代码。
function chatPetVariants(base)
{
    var out = [];
    if (chatPetManifest[base] !== undefined) { out.push(base); }
    for (var i = 2; ; i = i + 1)
    {
        var n = base + '-' + i;
        if (chatPetManifest[n] === undefined) { break; }
        out.push(n);
    }
    return out;
}

var chatPetVariantIdx = {};      // 每个分组上次用过的下标（避免连续重复）
var chatPetRunVariant = {};      // 每个活跃态当前显示的变体名（驻留时长要按它算）
var chatPetHookIdx = -1;         // 移入过渡的变体下标（before/loop 必须配同一对）
var chatPetSleepIdx = -1;        // 入睡过渡的同上

function chatPetPickVariant(base)
{
    var list = chatPetVariants(base);
    if (list.length === 0) { return base; }
    if (list.length === 1) { return list[0]; }
    var last = (chatPetVariantIdx[base] === undefined) ? -1 : chatPetVariantIdx[base];
    var idx = chatPetPick(list.length, last);
    chatPetVariantIdx[base] = idx;
    return list[idx];
}

function chatPetBaseName(name)
{
    // loop-idle-3 → loop-idle（接缝溶解名单是按基名登记的）
    return String(name).replace(/-\d+$/, '');
}

function chatPetCacheKey(u)
{
    // 缓存比对的规范化键：统一取 /pet/ 之后那一段。
    // 必须归一，否则「清单里的写法」与「Cache API 里的绝对 URL」对不上，
    // 每次加载都会把整个桶清空（v1 就是这样，只是当时只影响离线韧性、不易察觉）。
    var s = String(u);
    var k = s.indexOf('/pet/');
    return (k < 0) ? s : s.substring(k + 1);
}

var CHAT_PET_IDLE_BASE = chatPetVariants('loop-idle');
if (CHAT_PET_IDLE_BASE.length === 0) { CHAT_PET_IDLE_BASE = ['loop-idle']; }   // manifest 缺失时兜底

var CHAT_PET_CHECKS = [];
(function ()
{
    var vs = chatPetVariants('after-idle-check');
    if (vs.length === 0) { vs = ['after-idle-check']; }
    for (var i = 0; i < vs.length; i = i + 1) { CHAT_PET_CHECKS.push({ name: vs[i], ms: 640 }); }
})();
// ── 待机节律（DSH 适配层改过；套件原值是 CHAT_PET_IDLE_BASE_HOLD_MS = 5000）────
// 套件原本：待机 5 秒就入睡；而且待机只显示同一张图（当时素材只有一张）。
// DSH 场景改成：
//   · 待机每 15 秒换一张**随机**待机变体（不含睡觉），桌面上一直有变化
//   · **5 分钟**内既没有命令执行（没有活跃态来回切）也没有点击，才进入睡觉
var CHAT_PET_IDLE_ROTATE_MS = 15000;     // 待机换图间隔
var CHAT_PET_IDLE_SLEEP_MS = 300000;     // 睡意阈值：5 分钟无命令 / 无点击
var chatPetIdleSleepAt = 0;              // 睡意到点时刻（进入待机、点击、移入时重算）
// 入睡过渡遍数——before-idle-sleep 单遍 1980ms；取 2 遍 ≈ 3.96s（「5s 待机 → 约 3s 过渡 → 睡」，
// 且切点落在整遍边界不跳帧；实时长以 manifest 为准）
var CHAT_PET_BEFORE_SLEEP_LOOPS = 2;
// 最短驻留（莎 2026-09-18 定）：tool / run 至少播满「目标下限的真实循环整数倍」——
//   实测 loop-tool / loop-run 均 320ms → 7 遍 = 2.24s；素材重转后按公式自适应，不在这里留漂移常量
var CHAT_PET_MIN_LOOP_MS = 2000;   // 驻留目标下限（实际时长 = 循环时长 × ceil(下限 / 循环时长)）
var CHAT_PET_MIN_KEYS = { tool: true, run: true };   // 有驻留义务的态（其余态变化立即生效）
var CHAT_PET_LOOP_FALLBACK_MS = 320;   // 循环时长兜底（manifest 缺项时用）
// 以下为素材播放时长的**兜底值**——实际以 manifest 为准（chatPetMs）；素材重转后无需改这里
var CHAT_PET_BEFORE_IDLE_MS = 1980;      // before-idle 兜底时长
var CHAT_PET_BEFORE_HOOK_MS = 1140;      // before-idle-hook 兜底时长
var CHAT_PET_BEFORE_SLEEP_MS = 1980;     // before-idle-sleep 兜底时长

// 全量资源名（= manifest 的全部键）——用于缓存清理与参考。
// 注意：**它不再是预载清单**，预载由 chatPetLoadOrder() 收敛（见下）。
var chatPetFiles = [];
(function ()
{
    for (var k in chatPetManifest)
    {
        if (Object.prototype.hasOwnProperty.call(chatPetManifest, k)) { chatPetFiles.push(k); }
    }
    chatPetFiles.sort();
    if (chatPetFiles.length === 0)
    {
        // manifest 缺失（pet-manifest.js 没加载到）时的兜底——至少让基础链路能跑
        chatPetFiles = ['loop-link', 'loop-wait', 'loop-think', 'loop-tool', 'loop-run', 'loop-reply',
            'loop-sseErr', 'before-idle', 'loop-idle', 'loop-idle-hook', 'before-idle-hook',
            'loop-idle-sleep', 'before-idle-sleep', 'after-idle-check'];
    }
})();

// [段2] 基础操作
function chatPetClearTimer()
{
    // 显示调度单一定时器纪律——任何切换先清（防陈旧定时器改图）
    if (chatPetTimer !== null)
    {
        clearTimeout(chatPetTimer);
        chatPetTimer = null;
    }
}

function chatPetPick(n, last)
{
    // 随机取下标——避免与上一次相同（n=1 时直接返回 0）
    if (n <= 1) { return 0; }
    var idx = last;
    var guard = 0;
    while (idx === last && guard < 20)
    {
        idx = Math.floor(Math.random() * n);
        guard = guard + 1;
    }
    return idx;
}

function chatPetShow(name, instant)
{
    // 换图——useInstant 时瞬切（连续动作），否则双层交叉溶解 0.25s
    // 接缝溶解名单内的目标强制溶解（姿态不接，瞬切会跳帧）
    if (chatPetImgs[0] === null) { return; }
    if (chatPetCur === name) { return; }
    var useInstant = (instant === true) && (CHAT_PET_SEAM_BLEND[chatPetBaseName(name)] !== true);
    chatPetCur = name;
    chatPetLastInstant = useInstant;
    var cur = chatPetImgs[chatPetLayer];
    var next = chatPetImgs[1 - chatPetLayer];
    if (useInstant === true)
    {
        next.style.transition = 'none';
        cur.style.transition = 'none';
    }
    next.src = chatPetSheet(name);
    next.style.opacity = '1';
    cur.style.opacity = '0';
    if (useInstant === true)
    {
        void next.offsetWidth;          // 强制应用后再恢复过渡设置（此后切换仍溶解）
        next.style.transition = '';
        cur.style.transition = '';
    }
    chatPetLayer = 1 - chatPetLayer;
}

// [段3] 运行态与断线
function chatPetMinMs(key)
{
    // 最短驻留时长——目标下限 CHAT_PET_MIN_LOOP_MS，向上取真实循环时长的整数倍（至少一遍）
    var ms = chatPetMs(chatPetRunVariant[key] || chatPetPhaseMap[key], CHAT_PET_LOOP_FALLBACK_MS);
    if (ms <= 0) { return 0; }
    var loops = Math.ceil(CHAT_PET_MIN_LOOP_MS / ms);
    if (loops < 1) { loops = 1; }
    return ms * loops;
}

function chatPetClearDwell()
{
    // 解除驻留约束——清定时器与待切标记（离开被约束态 / 断线让位 / 重新起算前调用）
    if (chatPetDwellTimer !== null)
    {
        clearTimeout(chatPetDwellTimer);
        chatPetDwellTimer = null;
    }
    chatPetDwellActive = false;
    chatPetDwellPend = false;
}

function chatPetDwellStart(key)
{
    // 起算驻留——仅 tool / run（其余态无约束）；同态重入由调用方先行拦下
    chatPetClearDwell();
    if (CHAT_PET_MIN_KEYS[key] !== true) { return; }
    var ms = chatPetMinMs(key);
    if (ms <= 0) { return; }
    chatPetDwellActive = true;
    chatPetDwellTimer = setTimeout(function ()
    {
        chatPetDwellTimer = null;
        chatPetDwellDone();
    }, ms);
}

function chatPetDwellDone()
{
    // 驻留期满——解除约束；期内真实态变过则按**当前真实态**跳转（无变化则保持显示，此后变化立即生效）
    chatPetDwellActive = false;
    var pend = chatPetDwellPend;
    chatPetDwellPend = false;
    if (pend === true) { chatPetSync(); }
}

function chatPetDwellHold()
{
    // 驻留期内——真实态变化只记一笔，不换图（返回 true = 已挂起）
    if (chatPetDwellActive !== true) { return false; }
    chatPetDwellPend = true;
    return true;
}

function chatPetEnterRun(key)
{
    // 活跃态——六态直接映射循环资源（before-tool 前置已废弃：素材姿态与循环图对不齐）
    if (chatPetMode === 'run' && chatPetKey === key) { return; }
    if (chatPetDwellHold()) { return; }   // 驻留期内——只记变化，期满按当前真实态跳转（跳过中间态）
    chatPetMode = 'run';
    chatPetKey = key;
    chatPetKeyAt = Date.now();
    chatPetClearTimer();
    var vname = chatPetPickVariant(chatPetPhaseMap[key]);   // 同态每次换一张变体（不连续重复）
    chatPetRunVariant[key] = vname;
    chatPetShow(vname);
    chatPetDwellStart(key);
}

function chatPetEnterOffline()
{
    // 断线态——SSE 不通即显错图；恢复由引导层 onopen 置位后重新同步
    if (chatPetMode === 'offline') { return; }
    chatPetClearTimer();
    chatPetClearDwell();   // 断线优先——驻留让位（链路状态最需要可见）
    chatPetMode = 'offline';
    chatPetKey = 'offline';
    chatPetKeyAt = Date.now();
    chatPetShow('loop-sseErr');
}

// [段4] 空闲行为（intro / base / hook / check / sleep）
function chatPetEnterIdle()
{
    // 进入空闲——活跃态回空闲（= 整轮结束）先播 before-idle（after-reply 收尾动作）再进基础待机；
    // 加载完成首次、断线恢复回空闲均不播收尾（fromRun 判据）
    if (chatPetMode === 'idle') { return; }
    if (chatPetDwellHold()) { return; }   // 驻留期内——整轮结束也等播满（期满按当前真实态收尾 / 起态）
    var fromRun = (chatPetMode === 'run');
    chatPetMode = 'idle';
    chatPetKey = 'idle';
    chatPetKeyAt = Date.now();
    chatPetClearTimer();
    chatPetClearDwell();
    if (fromRun)
    {
        chatPetIdleMode = 'intro';
        var bidle = chatPetPickVariant('before-idle');
        chatPetShow(bidle);
        chatPetTimer = setTimeout(function ()
        {
            chatPetTimer = null;
            if (chatPetMode === 'idle' && chatPetIdleMode === 'intro') { chatPetPlayBase(true); }
        }, chatPetMs(bidle, CHAT_PET_BEFORE_IDLE_MS));
        return;
    }
    chatPetPlayBase(false);
}

function chatPetPlayBase(instant)
{
    // 基础待机入口——重算睡意起算点，然后交给轮换器。
    // 调用它的都是「有活动」的场合：回合结束回到空闲、点击摸头结束、鼠标移开。
    // （鼠标移入也算活动，见 chatPetIdleHook —— 否则停在鱼上超过 5 分钟、
    //   一移开它会立刻去睡，那个边角很怪。）
    chatPetIdleMode = 'base';
    chatPetIdleSleepAt = Date.now() + CHAT_PET_IDLE_SLEEP_MS;
    chatPetIdleRotate(instant);
}

function chatPetIdleRotate(instant)
{
    // 待机轮换——换一张随机变体（chatPetPick 保证不连续重复），
    // 并安排「下一次换图」或「到点入睡」。
    // 睡意是**绝对时刻**，所以每次换图不会把入睡时间往后推。
    if (chatPetMode !== 'idle' || chatPetIdleMode !== 'base') { return; }
    var idx = chatPetPick(CHAT_PET_IDLE_BASE.length, chatPetIdleIdx);
    chatPetIdleIdx = idx;
    chatPetClearTimer();
    chatPetShow(CHAT_PET_IDLE_BASE[idx], instant === true);
    var left = chatPetIdleSleepAt - Date.now();
    if (left <= 0) { chatPetStartSleep(); return; }
    chatPetTimer = setTimeout(function ()
    {
        chatPetTimer = null;
        if (chatPetMode !== 'idle' || chatPetIdleMode !== 'base') { return; }
        if (Date.now() >= chatPetIdleSleepAt) { chatPetStartSleep(); return; }
        chatPetIdleRotate(false);
    }, Math.min(CHAT_PET_IDLE_ROTATE_MS, left));
}

function chatPetIdleHook(on)
{
    // 鼠标移入/移出（仅空闲态响应——运行态优先，桌宠在陪干活）
    if (chatPetMode !== 'idle') { return; }
    if (on)
    {
        if (chatPetIdleMode === 'hook') { return; }
        chatPetIdleMode = 'hook';
        chatPetClearTimer();
        // 移入算一次活动，重置睡意（理由见 chatPetPlayBase）
        chatPetIdleSleepAt = Date.now() + CHAT_PET_IDLE_SLEEP_MS;
        // 变体按**下标配对**：第 i 个 before 与第 i 个 loop 拼成一次过渡。
        // before 缺失（本套素材没有独立的移入前置）就直接进 loop——
        // 这样加 loop 变体不必被迫造一堆没有意义的 before 素材。
        var hLoops = chatPetVariants('loop-idle-hook');
        if (hLoops.length === 0) { hLoops = ['loop-idle-hook']; }
        var hPicked = chatPetPick(hLoops.length, chatPetHookIdx);
        chatPetHookIdx = hPicked;
        var hLoop = hLoops[hPicked];
        var hBefores = chatPetVariants('before-idle-hook');
        var hBefore = (hBefores.length === 0) ? null : hBefores[Math.min(hPicked, hBefores.length - 1)];
        if (hBefore === null) { chatPetShow(hLoop, true); return; }
        chatPetShow(hBefore);
        chatPetTimer = setTimeout(function ()
        {
            chatPetTimer = null;
            if (chatPetMode === 'idle' && chatPetIdleMode === 'hook') { chatPetShow(hLoop, true); }
        }, chatPetMs(hBefore, CHAT_PET_BEFORE_HOOK_MS));
        return;
    }
    if (chatPetIdleMode === 'hook') { chatPetPlayBase(false); }
}

function chatPetIdleCheck()
{
    // 鼠标点击——after-idle-check 播一遍；结束后按悬停状态回 hook 或基础待机
    if (chatPetMode !== 'idle') { return; }
    chatPetIdleMode = 'check';
    var idx = chatPetPick(CHAT_PET_CHECKS.length, chatPetCheckIdx);
    chatPetCheckIdx = idx;
    chatPetClearTimer();
    chatPetShow(CHAT_PET_CHECKS[idx].name, true);   // loop → after：瞬切
    chatPetTimer = setTimeout(function ()
    {
        chatPetTimer = null;
        if (chatPetMode !== 'idle' || chatPetIdleMode !== 'check') { return; }
        if (chatPetHovered) { chatPetIdleMode = ''; chatPetIdleHook(true); }
        else { chatPetPlayBase(false); }
    }, chatPetMs(CHAT_PET_CHECKS[idx].name, CHAT_PET_CHECKS[idx].ms));
}

function chatPetStartSleep()
{
    // 入睡——before-idle-sleep 播**整遍**（共 CHAT_PET_BEFORE_SLEEP_LOOPS 遍）后瞬切进睡眠循环
    chatPetIdleMode = 'sleep';
    chatPetClearTimer();
    // 与移入同样的下标配对规则（见 chatPetIdleHook 的注释）
    var sLoops = chatPetVariants('loop-idle-sleep');
    if (sLoops.length === 0) { sLoops = ['loop-idle-sleep']; }
    var sPicked = chatPetPick(sLoops.length, chatPetSleepIdx);
    chatPetSleepIdx = sPicked;
    var sLoop = sLoops[sPicked];
    var sBefores = chatPetVariants('before-idle-sleep');
    var sBefore = (sBefores.length === 0) ? null : sBefores[Math.min(sPicked, sBefores.length - 1)];
    if (sBefore === null) { chatPetShow(sLoop, true); return; }
    chatPetShow(sBefore);
    chatPetTimer = setTimeout(function ()
    {
        chatPetTimer = null;
        if (chatPetMode === 'idle' && chatPetIdleMode === 'sleep') { chatPetShow(sLoop, true); }
    }, chatPetMs(sBefore, CHAT_PET_BEFORE_SLEEP_MS) * CHAT_PET_BEFORE_SLEEP_LOOPS);
}

// [段5] 对外接口
function chatPetSync()
{
    // 状态同步——由 chatRenderStatus 汇聚点回调（对话页每次状态渲染后）
    if (chatPetImgs[0] === null) { return; }
    if (chatPetLoading === true) { return; }   // 加载门禁——未就绪不调度（保持 sseErr 加载态）
    if (chatPetOffline) { chatPetEnterOffline(); return; }
    var st = '';
    if (window.chatRunState !== undefined && window.chatRunState !== null && window.chatRunState.state)
    {
        st = window.chatRunState.state;
    }
    if (st !== '' && chatPetPhaseMap[st] !== undefined) { chatPetEnterRun(st); return; }
    chatPetEnterIdle();
}

function chatPetSetOffline(on)
{
    // 断线置位/恢复——引导层 EventSource onerror/onopen 调用
    chatPetOffline = (on === true);
    chatPetSync();
}

function chatPetUrl(name)
{
    // 素材 URL——带内容哈希版本（改图/改名即换 URL，缓存自动失效且只重下变动那张）
    //
    // ── 唯一一处对套件原件的改动（DSH 插件化适配）──────────────────────────
    // 原件写死相对路径 'pet/'——那是网页宿主把素材与页面放在同一层的假设。
    // 挂进 DSH 后页面在站点根 '/', 相对路径会解析成 '/pet/...'，
    // 而本插件的静态资源统一在 '/petkit/' 下，且不该占用站点根命名空间。
    // 所以改读一个可配置基址：宿主（glue.js）在加载本文件之前设
    //   window.chatPetAssetBase = '/petkit/pet/';
    // 不设时行为与原件完全一致（回落 'pet/'），原件仍是唯一真相。
    var base = (typeof window !== 'undefined' && window.chatPetAssetBase)
        ? window.chatPetAssetBase : 'pet/';
    var m = chatPetManifest[name];
    if (m === undefined || m.h === undefined) { return base + name + '.webp'; }
    return base + name + '.webp?v=' + m.h;
}

function chatPetMs(name, fallback)
{
    // 素材播放时长——单一真相在 manifest（素材重转即跟随，前端不留漂移常量）
    var m = chatPetManifest[name];
    if (m === undefined || m.ms === undefined || m.ms <= 0) { return fallback; }
    return m.ms;
}

function chatPetSheet(name)
{
    // 换图用 URL——持有表命中用 blob（宿主不可达时仍可切图），未就绪回落网络路径
    var url = chatPetRes[name];
    if (url === undefined) { return chatPetUrl(name); }
    return url;
}

function chatPetLoadOrder()
{
    // 预载序（DSH 适配层收敛过）——**不再全量预载**。
    // 157 张全预载会拖慢启动（门禁要等全部载完才开放调度）并白吃上百 MB 内存，
    // 而这里是本机同源、且 webp 走 immutable + 内容哈希 URL，
    // 按需载入的那张第二次就命中浏览器缓存。所以只预载：
    //   ① 每个分组的第 1 张（基础链路零延迟）
    //   ② 前 6 张待机变体（待机是看得最久的，变化要立刻出现）
    // 其余由 chatPetSheet() 自动回落网络路径。
    var eager = ['loop-sseErr', 'loop-link', 'loop-wait', 'loop-think', 'loop-tool', 'loop-run',
        'loop-reply', 'before-idle', 'loop-idle', 'loop-idle-hook', 'loop-idle-sleep',
        'before-idle-sleep', 'after-idle-check'];
    var idleVs = chatPetVariants('loop-idle');
    for (var v = 0; v < idleVs.length && v < 6; v = v + 1) { eager.push(idleVs[v]); }
    var out = [];
    var seen = {};
    for (var i = 0; i < eager.length; i = i + 1)
    {
        var n = eager[i];
        if (seen[n] === true || chatPetManifest[n] === undefined) { continue; }
        seen[n] = true;
        out.push(n);
    }
    if (out.length === 0) { return ['loop-sseErr']; }
    if (out[0] !== 'loop-sseErr') { out.unshift('loop-sseErr'); }   // 首图门禁靠它
    return out;
}

function chatPetPruneEntries(cache, names)
{
    // 桶内清理——删掉不在当前清单里的条目（素材改名/删除后不留死条目）；清理失败不影响本次使用
    if (cache === null || cache === undefined) { return Promise.resolve(0); }
    var want = {};
    for (var i = 0; i < names.length; i = i + 1) { want[chatPetCacheKey(chatPetUrl(names[i]))] = true; }
    return cache.keys().then(function (reqs)
    {
        var jobs = [];
        for (var j = 0; j < reqs.length; j = j + 1)
        {
            var u = String(reqs[j].url);
            if (u.indexOf('/pet/') < 0) { continue; }
            if (want[chatPetCacheKey(u)] !== true) { jobs.push(cache.delete(reqs[j])); }
        }
        return Promise.all(jobs).then(function () { return jobs.length; });
    }).catch(function () { return 0; });
}

function chatPetOpenCache()
{
    // 缓存桶——固定名；无 Cache API 环境降级 null（每次走网络）
    if (typeof caches === 'undefined' || caches === null) { return Promise.resolve(null); }
    return caches.open(CHAT_PET_CACHE_PREFIX).catch(function () { return null; });
}

function chatPetFetch(url, cache)
{
    // 网络取回 + 回写缓存——非 2xx 不写（避免把 404 固化）；写缓存失败不致命
    return fetch(url).then(function (r)
    {
        if (r.ok === true && cache !== null && cache !== undefined)
        {
            try { cache.put(url, r.clone()).catch(function () { }); } catch (e) { }
        }
        return r;
    });
}

function chatPetLoadOne(name, cache)
{
    // 单张素材——缓存命中直取（零网络）；未命中走网络。返回 Promise（resolve=名称）
    var url = chatPetUrl(name);
    var get = null;
    if (cache !== null && cache !== undefined)
    {
        get = cache.match(url).then(function (hit)
        {
            if (hit === undefined || hit === null) { return chatPetFetch(url, cache); }
            return hit;
        });
    }
    else
    {
        get = chatPetFetch(url, cache);
    }
    return get.then(function (r)
    {
        if (r.ok !== true) { throw new Error('HTTP ' + r.status); }
        return r.blob();
    }).then(function (b)
    {
        chatPetRes[name] = URL.createObjectURL(b);
        return name;
    });
}

function chatPetBoot()
{
    // 首图就位后的启动——桌宠显形并常显 sseErr 作加载态；首图失败则保持不可见（不挂破图）
    if (chatPetBooted === true) { return; }
    chatPetBooted = true;
    chatPetMode = 'loading';
    chatPetKey = 'loading';
    chatPetKeyAt = Date.now();
    if (chatPetRes['loop-sseErr'] !== undefined) { chatPetShow('loop-sseErr'); }
}

function chatPetLoadDone()
{
    // 全量结束——解除门禁并开放调度；有失败则汇总告警（具名不静默）
    chatPetLoading = false;
    if (chatPetFail > 0) { uiWarn('桌宠素材', new Error('加载失败 ' + chatPetFail + ' 张——相关态回落网络路径')); }
    chatPetSync();
}

function chatPetLoadSeq(names, i, cache)
{
    // 串行逐张——前后不并发（限带宽/高延迟场景不拥塞，卡点可定位）；失败继续下一张
    if (i >= names.length)
    {
        chatPetLoadDone();
        return;
    }
    chatPetLoadOne(names[i], cache)
        .then(function ()
        {
            if (i === 0) { chatPetBoot(); }
            chatPetLoadSeq(names, i + 1, cache);
        })
        .catch(function (e)
        {
            chatPetFail = chatPetFail + 1;
            uiWarn('桌宠素材 ' + names[i], e);
            if (i === 0) { chatPetBoot(); }
            chatPetLoadSeq(names, i + 1, cache);
        });
}

function chatPetLoadAll()
{
    // 加载总入口——清单随脚本同步就位（无需异步取）；无加载通道（非浏览器环境）直接解除门禁
    if (typeof fetch !== 'function') { chatPetLoading = false; return; }
    if (typeof URL.createObjectURL !== 'function') { chatPetLoading = false; return; }
    var names = chatPetLoadOrder();
    chatPetOpenCache().then(function (cache)
    {
        chatPetPruneEntries(cache, names);
        chatPetLoadSeq(names, 0, cache);
    });
}

function chatPetInit()
{
    // 初始化——引导层调用；容器缺失时静默退出（防御式，不影响对话主功能）
    chatPetImgs = [document.getElementById('chatPetImgA'), document.getElementById('chatPetImgB')];
    var box = document.getElementById('chatPet');
    if (chatPetImgs[0] === null || chatPetImgs[1] === null || box === null) { return; }
    // 鼠标交互（移入 hook / 点击 check / 按下拖动改位置）
    box.addEventListener('mouseenter', function () { chatPetHovered = true; chatPetIdleHook(true); });
    box.addEventListener('mouseleave', function () { chatPetHovered = false; chatPetIdleHook(false); });
    box.addEventListener('click', function ()
    {
        if (chatPetDragMoved) { return; }   // 拖动收尾的 click 不算摸头
        chatPetIdleCheck();
    });
    box.addEventListener('mousedown', chatPetDragStart);
    document.addEventListener('mousemove', chatPetDragMove);
    document.addEventListener('mouseup', chatPetDragEnd);
    var elClear = document.getElementById('chatCacheClear');
    if (elClear !== null) { elClear.addEventListener('click', chatPetClearCache); }
    chatPetLoadAll();
}

function chatPetDragStart(e)
{
    // 按下——记录抓取偏移；right/bottom 定位换算为 left/top（此后以左上角定位）
    if (chatPetLoading === true) { return; }   // 加载门禁——未启动前不可拖
    var box = document.getElementById('chatPet');
    if (box === null) { return; }
    var r = box.getBoundingClientRect();
    chatPetDragMoved = false;
    chatPetDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY };
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    e.preventDefault();
}

function chatPetDragMove(e)
{
    // 拖动——位移超阈值才算拖动（避免手抖吃掉摸头点击）；限制在视口内
    if (chatPetDrag === null) { return; }
    var box = document.getElementById('chatPet');
    if (box === null) { return; }
    var moved = Math.abs(e.clientX - chatPetDrag.x0) + Math.abs(e.clientY - chatPetDrag.y0);
    if (chatPetDragMoved === false && moved < 4) { return; }
    chatPetDragMoved = true;
    var x = e.clientX - chatPetDrag.dx;
    var y = e.clientY - chatPetDrag.dy;
    var maxX = window.innerWidth - box.offsetWidth;
    var maxY = window.innerHeight - box.offsetHeight;
    if (x < 0) { x = 0; }
    if (y < 0) { y = 0; }
    if (x > maxX) { x = maxX; }
    if (y > maxY) { y = maxY; }
    box.style.left = x + 'px';
    box.style.top = y + 'px';
}

function chatPetDragEnd()
{
    // 释放——结束拖动（moved 标志保留至下次按下，供 click 判据）
    chatPetDrag = null;
}

function chatPetTip(msg)
{
    // 轻量提示——复用顶部状态位（缺失则退到 console）
    var el = document.getElementById('chatInfo');
    if (el !== null) { el.textContent = msg; return; }
    if (typeof console !== 'undefined' && console.log) { console.log('[桌宠] ' + msg); }
}

function chatPetClearCache()
{
    // 硬保底——清空素材缓存桶（改图不改名 / 缓存脏数据时的主动恢复手段）
    if (typeof caches === 'undefined' || caches === null)
    {
        chatPetTip('本环境不支持缓存');
        return;
    }
    caches.keys().then(function (keys)
    {
        var jobs = [];
        for (var i = 0; i < keys.length; i = i + 1)
        {
            if (keys[i].indexOf(CHAT_PET_CACHE_PREFIX) === 0) { jobs.push(caches.delete(keys[i])); }
        }
        return Promise.all(jobs).then(function () { return jobs.length; });
    }).then(function (n)
    {
        chatPetTip('素材缓存已清理（' + n + ' 桶）——刷新后重新加载');
    }).catch(function (e) { uiWarn('桌宠缓存清理', e); });
}
