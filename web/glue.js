/**
 * petkit glue —— DSH 側的引導層。
 *
 * 套件的 chat-pet.js 是一台「讀 window.chatRunState.state → 換圖」的狀態機，
 * 它不關心狀態從哪來。這個檔案負責：
 *   1. 造出契約要求的 DOM（#chatPet + 雙層 img）——DSH 是 React 應用，
 *      插不進去的容器只能由指令碼自己建。
 *   2. 訂閱宿主推送的狀態流（SSE），一行覆蓋式賦值 window.chatRunState。
 *   3. SSE 斷線 → chatPetSetOffline(true)，重連成功 → false
 *      （這正是套件設計裡 sseErr / loop-sseErr 的來源）。
 *   4. 連線中的過渡態顯示 link（loop-link）。
 *
 * ── 兩個為了「掛進別人的頁面」而加的保險 ──────────────────────────────────
 * · **SSE 看門狗**：EventSource 有「連上了但一幀都不來」的失敗模式
 *   （服務端壓縮／緩衝串流回應時就是這樣），此時既沒有 onmessage 也沒有 onerror，
 *   桌寵會永遠停在 link 態。所以 2.5s 內收不到任何訊息就自動並上輪詢；
 *   輪詢走 /petkit/state.json，已驗證可用。
 * · **除錯徽章**：網址帶 #petkit-debug 時，左上角顯示一行內部狀態。
 *   桌寵不動時排查不必開 DevTools。
 *
 * 契約（不可改）：#chatPet / #chatPetImgA / #chatPetImgB 三個 id 名稱、
 * 以及先載入 pet-manifest.js 再載入 chat-pet.js 的順序。
 */
(function () {
    'use strict';

    if (window.__petkitGlueLoaded) { return; }   // 注入可能因熱重載來兩次
    window.__petkitGlueLoaded = true;

    var ROUTE = '/petkit';
    var SSE_QUIET_MS = 2500;      // 這麼久沒有任何 SSE 訊息就並上輪詢
    var POLL_MS = 700;

    var esState = -1;             // EventSource.readyState（-1 = 還沒建）
    var esMsgs = 0;
    var pollStarted = false;

    // ── 1. DOM ────────────────────────────────────────────────────────────
    function mount() {
        if (document.getElementById('chatPet') !== null) { return; }
        var box = document.createElement('div');
        box.id = 'chatPet';
        box.setAttribute('aria-hidden', 'true');   // 裝飾性，不進無障礙樹
        var a = document.createElement('img');
        a.id = 'chatPetImgA';
        a.alt = '';
        var b = document.createElement('img');
        b.id = 'chatPetImgB';
        b.alt = '';
        box.appendChild(a);
        box.appendChild(b);
        document.body.appendChild(box);
    }

    // ── 2. 狀態來源 ───────────────────────────────────────────────────────
    function applyState(state) {
        // 一行覆蓋式賦值——這就是真實接入時後端要做的全部事情
        window.chatRunState = { state: state || '' };
        if (typeof window.chatPetSync === 'function') { window.chatPetSync(); }
    }

    function setOffline(on) {
        if (typeof window.chatPetSetOffline === 'function') { window.chatPetSetOffline(on); }
    }

    function startPolling() {
        if (pollStarted) { return; }
        pollStarted = true;
        setInterval(function () {
            fetch(ROUTE + '/state.json', { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    setOffline(false);
                    applyState(d && d.state);
                })
                .catch(function () { setOffline(true); });
        }, POLL_MS);
    }

    function startStream() {
        if (typeof window.EventSource !== 'function') { startPolling(); return; }

        var es = new EventSource(ROUTE + '/events');
        window.__petkitEs = es;

        es.onmessage = function (ev) {
            esMsgs = esMsgs + 1;
            esState = es.readyState;
            try {
                var d = JSON.parse(ev.data);
                applyState(d && d.state);
            } catch (err) { /* 壞幀忽略，下一幀再說 */ }
        };
        es.onopen = function () {
            esState = es.readyState;
            setOffline(false);
        };
        // EventSource 自己會重連；這裡只把「斷線」告訴桌寵（→ loop-sseErr）
        es.onerror = function () {
            esState = es.readyState;
            setOffline(true);
        };

        // 看門狗：連上了卻一幀不來 → 並上輪詢（兩者同時跑不衝突，值一樣）
        setTimeout(function () {
            if (esMsgs === 0) { startPolling(); }
        }, SSE_QUIET_MS);

        window.addEventListener('beforeunload', function () { es.close(); });
    }

    // ── 3. 除錯徽章（#petkit-debug）────────────────────────────────────────
    function startDebug() {
        var pre = document.createElement('pre');
        pre.id = 'petkitDebug';
        pre.style.cssText = 'position:fixed;left:8px;top:8px;z-index:100000;margin:0;'
            + 'padding:6px 9px;background:rgba(0,0,0,.82);color:#7fe3a0;'
            + 'font:11px/1.5 ui-monospace,Consolas,monospace;border-radius:6px;'
            + 'white-space:pre-wrap;max-width:60vw;pointer-events:none';
        document.body.appendChild(pre);
        setInterval(function () {
            var line = {
                runState: (window.chatRunState && window.chatRunState.state) || '',
                loading: window.chatPetLoading,
                booted: window.chatPetBooted,
                offline: window.chatPetOffline,
                fail: window.chatPetFail,
                imgs: !!(window.chatPetImgs && window.chatPetImgs[0]),
                res: window.chatPetRes ? Object.keys(window.chatPetRes).length : -1,
                key: window.chatPetKey,
                mode: window.chatPetMode,
                base: window.chatPetAssetBase,
                es: esState,
                msgs: esMsgs,
                poll: pollStarted
            };
            pre.textContent = 'petkit ' + JSON.stringify(line);
        }, 400);
    }

    // ── 4. 啟動 ───────────────────────────────────────────────────────────
    function boot() {
        mount();
        if (typeof window.chatPetInit !== 'function') { return; }
        // 素材基址必須與宿主註冊的資源路由前綴一致（/petkit/web/pet/）。
        // 客戶端才是 URL 的權威：宿主注入的 global 行只是兜底，這裡覆蓋它。
        // （第一版就是兩邊漂移了——基址 /petkit/pet/ 而路由在 /petkit/web/pet/，
        //   素材全 404，而套件的「首圖就位前不顯示」門禁讓桌寵永遠隱形。）
        window.chatPetAssetBase = ROUTE + '/web/pet/';
        window.chatPetInit();          // 素材載入門禁：就位前桌寵保持不可見
        // 載入門禁保險：套件在全部素材載完前不開放調度（設計如此，避免破圖）。
        // 但若預取卡住（單張 promise 永不 settle），桌寵會永遠停在載入態——
        // 12 秒後強制解除門禁；缺的素材由套件的 chatPetSheet() 自動回落網路路徑，
        // 所以放行只會少一兩張的預取優勢，不會破圖。
        setTimeout(function () {
            if (window.chatPetLoading === true) {
                window.chatPetLoading = false;
                if (typeof window.chatPetSync === 'function') { window.chatPetSync(); }
            }
        }, 12000);
        applyState('link');            // 連上第一幀之前 = 連接中
        startStream();
        // 除錯開關：網址 hash 或 localStorage 任一命中即可。
        // 桌面端頁面在 dsh-app://app/，改 hash 不方便——用 DevTools（桌面端 Ctrl+Shift+I）
        // 執行 localStorage.setItem('petkit-debug','1') 再重載即可；關掉就 removeItem。
        var dbg = false;
        try {
            dbg = (String(location.hash).indexOf('petkit-debug') >= 0)
                || (window.localStorage !== undefined && localStorage.getItem('petkit-debug') === '1');
        } catch (e) { /* 隱私模式等取不到就當作關 */ }
        if (dbg) { startDebug(); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
