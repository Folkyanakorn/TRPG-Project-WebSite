"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a2f3d"/>' +
    '<circle cx="32" cy="24" r="11" fill="#6b7288"/><path d="M10 60c2-14 12-20 22-20s20 6 22 20z" fill="#6b7288"/></svg>');

function store(key, value) {
    try { if (value === undefined) return sessionStorage.getItem(key); sessionStorage.setItem(key, value); } catch (e) {}
    return null;
}
function lstore(key, value) {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) {}
    return null;
}

const S = {
    token: store("trpg_token") || "",
    ws: null,
    me: null,
    users: [],
    slots: { left: null, right: null },
    queue: [],
    job: null,
    fadeTimer: null,
    retry: 0,
    authFailed: false,
    bgmId: null,
    volume: parseInt(lstore("trpg_vol") || "50", 10),
    muted: lstore("trpg_muted") === "1",
    qteTimer: null,
};

// ------------------------------------------------------------------ utils
let toastTimer;
function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function setAuthMsg(msg, ok = false) {
    const el = $("auth-msg");
    el.textContent = msg || "";
    el.classList.toggle("ok", !!ok);
}
function errText(data) {
    if (data && typeof data.detail === "string") return data.detail;
    return "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง";
}
function avatarOr(url) { return url || DEFAULT_AVATAR; }
function fixImg(img) { img.onerror = () => { img.onerror = null; img.src = DEFAULT_AVATAR; }; }
function isAdmin() { return !!(S.me && S.me.is_admin); }

// ------------------------------------------------------------------ audio (blip + BGM)
let audioCtx;
function initAudio() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
}
function playBlip(pitch = 450) {
    if (!audioCtx || S.muted) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = audioCtx.currentTime;
    osc.type = "square";
    osc.frequency.setValueAtTime(pitch, t);
    gain.gain.setValueAtTime(0.012 * (S.volume / 50), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(t + 0.03);
}

let yt = null, ytReady = false;
window.onYouTubeIframeAPIReady = () => {
    yt = new YT.Player("yt-player", {
        width: 200, height: 200,
        playerVars: { controls: 0, playsinline: 1, disablekb: 1, rel: 0 },
        events: {
            onReady: () => { ytReady = true; applyVolume(); if (S.bgmId) playBgm(S.bgmId); },
            onStateChange: (e) => { if (window.YT && e.data === YT.PlayerState.ENDED) yt.playVideo(); }, // วนเพลง
            onError: () => toast("เล่นเพลงนี้ไม่ได้ (วิดีโออาจไม่อนุญาตให้ฝัง)"),
        },
    });
};
if (window.YT && window.YT.Player && !yt) window.onYouTubeIframeAPIReady();

function applyVolume() {
    $("vol").value = S.volume;
    $("mute-btn").textContent = S.muted ? "ปิด" : "เปิด";
    if (!ytReady) return;
    try { yt.setVolume(S.volume); S.muted ? yt.mute() : yt.unMute(); } catch (e) {}
}
function playBgm(id) {
    S.bgmId = id;
    if (!ytReady) return;
    try { yt.loadVideoById(id); applyVolume(); } catch (e) {}
}
function stopBgm() {
    S.bgmId = null;
    if (ytReady) { try { yt.stopVideo(); } catch (e) {} }
}
// เบราว์เซอร์บล็อกเสียงจนกว่าจะมีการโต้ตอบ — ปลดล็อกตอนคลิก/กดคีย์ครั้งแรก
function unlockAudio() {
    initAudio();
    if (S.bgmId && ytReady) {
        try {
            const st = yt.getPlayerState();
            if (st !== 1 && st !== 3) yt.loadVideoById(S.bgmId);
        } catch (e) {}
    }
}
["pointerdown", "keydown"].forEach((ev) =>
    window.addEventListener(ev, function once() {
        unlockAudio();
        window.removeEventListener("pointerdown", once);
        window.removeEventListener("keydown", once);
    }));

// ------------------------------------------------------------------ auth
async function api(path, body) {
    try {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        let data = {};
        try { data = await res.json(); } catch (e) {}
        return { ok: res.ok, data };
    } catch (e) {
        return { ok: false, data: { detail: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้" } };
    }
}

function showAuth(registerMode = false) {
    $("auth-screen").style.display = "flex";
    $("login-box").style.display = registerMode ? "none" : "block";
    $("register-box").style.display = registerMode ? "block" : "none";
}

async function login() {
    const username = $("login-user").value.trim();
    const password = $("login-pass").value;
    if (!username || !password) return setAuthMsg("กรุณากรอกชื่อและรหัสผ่าน");
    setAuthMsg("");
    const { ok, data } = await api("/login", { username, password });
    if (!ok) return setAuthMsg(errText(data));
    S.token = data.token;
    S.authFailed = false;
    store("trpg_token", S.token);
    $("login-pass").value = "";
    unlockAudio();
    connect();
}

async function register() {
    const username = $("reg-user").value.trim();
    const password = $("reg-pass").value;
    const avatar_url = $("reg-avatar").value.trim();
    if (!username || !password) return setAuthMsg("กรุณากรอกชื่อและรหัสผ่าน");
    setAuthMsg("");
    const { ok, data } = await api("/register", { username, password, avatar_url });
    if (!ok) return setAuthMsg(errText(data));
    showAuth(false);
    $("login-user").value = username;
    $("login-pass").focus();
    setAuthMsg(data.message, true);
}

async function logout() {
    await api("/logout", { token: S.token });
    store("trpg_token", "");
    S.authFailed = true;
    location.reload();
}

// ------------------------------------------------------------------ websocket
function connect() {
    if (S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch (e) {} }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}`);
    S.ws = ws;
    ws.onopen = () => { S.retry = 0; };
    ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        handle(msg);
    };
    ws.onclose = () => {
        if (S.ws !== ws || S.authFailed) return;
        S.retry += 1;
        toast("การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่...");
        setTimeout(() => { if (S.ws === ws && !S.authFailed) connect(); }, Math.min(8000, 1000 * S.retry));
    };
}

function send(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) { S.ws.send(JSON.stringify(obj)); return true; }
    toast("ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์");
    return false;
}

function handle(msg) {
    switch (msg.type) {
        case "auth_error":
            S.authFailed = true;
            store("trpg_token", "");
            showAuth(false);
            setAuthMsg(S.token ? "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" : "");
            break;
        case "init": onInit(msg); break;
        case "presence": S.users = msg.users; renderUsers(); break;
        case "chat_render": enqueue(msg.data); break;
        case "scene_state": renderSlots(msg.slots); break;
        case "bg_control": setBackground(msg.url); break;
        case "play_audio": playBgm(msg.yt_id); break;
        case "stop_audio": stopBgm(); break;
        case "vfx": if (msg.effect === "screen_shake") shake(); break;
        case "qte_start": startQTE(msg.action, msg.time_limit); break;
        case "choices_display": showChoices(msg.choices); break;
        case "choices_clear": $("choices-overlay").style.display = "none"; break;
        case "error": toast(msg.message); break;
    }
}

function onInit(msg) {
    S.me = msg.me;
    S.users = msg.users;
    $("auth-screen").style.display = "none";
    setAuthMsg("");

    // ล้างสถานะเก่า (กรณี reconnect) แล้ว render ประวัติแชททั้งหมดแบบทันที
    if (S.job) S.job.cancel();
    S.queue = [];
    $("chat-history").innerHTML = "";
    msg.history.forEach((d) => appendChatRow(d));
    scrollChat();

    $("me-name").textContent = S.me.username;
    $("me-rank").textContent = S.me.rank;
    $("me-avatar").src = avatarOr(S.me.avatar_url); fixImg($("me-avatar"));
    $("dm-panel").style.display = isAdmin() ? "flex" : "none";
    document.querySelectorAll(".player-only").forEach((el) => { el.style.display = isAdmin() ? "none" : ""; });

    if (msg.state.bg) setBackground(msg.state.bg);
    renderSlots(msg.state.slots);
    if (msg.state.bgm) playBgm(msg.state.bgm);
    renderUsers();
    applyVolume();
}

// ------------------------------------------------------------------ users / status
function pct(v, max) { return Math.max(0, Math.min(100, max ? (v / max) * 100 : 0)); }

function renderUsers() {
    if (!S.me) return;
    const me = S.users.find((u) => u.username === S.me.username);
    if (me) {
        const setIn = (el, v) => { if (document.activeElement !== el) el.value = v; };
        setIn($("hp-val"), me.hp); setIn($("sp-val"), me.sp);
        $("hp-val").max = me.max_hp; $("sp-val").max = me.max_sp;
        $("hp-max").textContent = me.max_hp; $("sp-max").textContent = me.max_sp;
        $("hp-bar").style.width = pct(me.hp, me.max_hp) + "%";
        $("sp-bar").style.width = pct(me.sp, me.max_sp) + "%";
    }

    const party = $("party");
    party.innerHTML = "";
    S.users.forEach((u) => {
        const row = document.createElement("div");
        row.className = "party-row";
        const img = document.createElement("img");
        img.src = avatarOr(u.avatar_url); fixImg(img);
        const name = document.createElement("div");
        name.className = "party-name";
        name.textContent = u.username;
        if (u.is_admin) {
            const tag = document.createElement("span");
            tag.className = "tag"; tag.textContent = "DM";
            name.appendChild(tag);
        }
        row.append(img, name);
        if (!u.is_admin) {
            const bars = document.createElement("div");
            bars.className = "party-bars";
            bars.innerHTML = '<div class="bar hp"><i></i></div><div class="bar sp"><i></i></div>';
            bars.children[0].title = `HP ${u.hp}/${u.max_hp}`;
            bars.children[1].title = `SP ${u.sp}/${u.max_sp}`;
            bars.children[0].firstChild.style.width = pct(u.hp, u.max_hp) + "%";
            bars.children[1].firstChild.style.width = pct(u.sp, u.max_sp) + "%";
            row.appendChild(bars);
        }
        party.appendChild(row);
    });

    if (isAdmin()) renderDmTargets();
}

function renderDmTargets() {
    const sel = $("dm-target");
    const prev = sel.value;
    const players = S.users.filter((u) => !u.is_admin);
    sel.innerHTML = "";
    players.forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.username; opt.textContent = u.username;
        sel.appendChild(opt);
    });
    if (players.some((u) => u.username === prev)) sel.value = prev;
    if (document.activeElement.closest && !document.activeElement.closest("#dm-panel .row")) fillDmStatus();
}
function fillDmStatus() {
    const u = S.users.find((x) => x.username === $("dm-target").value);
    if (!u) return;
    $("dm-hp").value = u.hp; $("dm-maxhp").value = u.max_hp;
    $("dm-sp").value = u.sp; $("dm-maxsp").value = u.max_sp;
}

function sendMyStatus() {
    send({ type: "set_status", hp: $("hp-val").value, sp: $("sp-val").value });
}

// ------------------------------------------------------------------ scene
function renderSlots(slots) {
    S.slots = slots;
    ["left", "right"].forEach((side) => {
        const el = $("slot-" + side);
        const info = slots[side];
        if (info) {
            const img = $("img-" + side);
            img.src = avatarOr(info.avatar); fixImg(img);
            $("name-" + side).textContent = info.user;
            el.classList.add("show");
        } else {
            el.classList.remove("show");
        }
        el.classList.remove("dim");
    });
    const mine = ["left", "right"].find((s) => slots[s] && S.me && slots[s].user === S.me.username);
    $("leave-scene").style.opacity = mine ? "1" : "0.5";
    $("enter-left").classList.toggle("btn-primary", mine === "left");
    $("enter-right").classList.toggle("btn-primary", mine === "right");
}

function highlightSpeaker(name) {
    const inScene = ["left", "right"].some((s) => S.slots[s] && S.slots[s].user === name);
    ["left", "right"].forEach((s) => {
        const info = S.slots[s];
        $("slot-" + s).classList.toggle("dim", inScene && info && info.user !== name);
    });
}

function setBackground(url) {
    const probe = new Image();
    probe.onload = () => { $("vn-screen").style.backgroundImage = `url(${JSON.stringify(url)})`; };
    probe.onerror = () => { if (isAdmin()) toast("โหลดรูปฉากหลังไม่ได้ ตรวจสอบลิงก์อีกครั้ง"); };
    probe.src = url;
}

function shake() {
    document.body.classList.remove("shake");
    void document.body.offsetWidth;
    document.body.classList.add("shake");
    setTimeout(() => document.body.classList.remove("shake"), 450);
}

// ------------------------------------------------------------------ QTE / choices
function startQTE(action, seconds) {
    if (isAdmin()) return toast(`ส่ง QTE แล้ว: ${action}`);
    const overlay = $("qte-overlay");
    clearTimeout(S.qteTimer);
    $("qte-title").textContent = action;
    const fill = $("qte-fill");
    fill.style.animation = "none";
    void fill.offsetWidth;
    fill.style.animation = `qte-drain ${seconds}s linear forwards`;
    overlay.style.display = "block";
    S.qteTimer = setTimeout(() => {
        if (overlay.style.display !== "none") {
            overlay.style.display = "none";
            send({ type: "qte_result", ok: false });
        }
    }, seconds * 1000);
}

function showChoices(choices) {
    if (isAdmin()) return toast("ส่งตัวเลือกแล้ว");
    const box = $("choices-container");
    box.innerHTML = "";
    choices.forEach((c) => {
        const btn = document.createElement("button");
        btn.className = "btn choice-btn";
        btn.textContent = c;
        btn.onclick = () => {
            $("choices-overlay").style.display = "none";
            send({ type: "choice", text: c });
        };
        box.appendChild(btn);
    });
    $("choices-overlay").style.display = "block";
}

// ------------------------------------------------------------------ chat + typewriter
function scrollChat() { const c = $("chat-history"); c.scrollTop = c.scrollHeight; }

function appendChatRow(d) {
    const isSys = d.sender === "System";
    const row = document.createElement("div");
    row.className = "chat-msg" + (d.is_interrupt ? " interrupt" : "") + (isSys ? " system" : "");
    if (!isSys) {
        const img = document.createElement("img");
        img.className = "chat-avatar"; img.src = avatarOr(d.avatar_url); fixImg(img);
        row.appendChild(img);
    }
    const content = document.createElement("div");
    content.className = "chat-content";
    const name = document.createElement("div");
    name.className = "chat-name"; name.textContent = d.sender;
    const text = document.createElement("span");
    text.className = "chat-text";
    if (d.rich) text.innerHTML = d.text; else text.textContent = d.text; // rich สร้างโดยเซิร์ฟเวอร์เท่านั้น (escape แล้ว)
    content.append(name, text);
    row.appendChild(content);
    $("chat-history").appendChild(row);
    return text;
}

function enqueue(d) {
    if (d.is_interrupt) S.queue.unshift(d); else S.queue.push(d);
    pump();
}
function pump() {
    if (S.job || !S.queue.length) return;
    S.job = playMessage(S.queue.shift());
}

function playMessage(d) {
    const isSys = d.sender === "System";
    const box = $("vn-dialog-box");
    const vnText = $("vn-dialog-text");
    const avatar = $("vn-dialog-avatar");

    clearTimeout(S.fadeTimer);
    box.classList.remove("idle");
    box.classList.toggle("interrupt", !!d.is_interrupt);
    box.style.display = "flex";
    $("vn-dialog-name").textContent = isSys ? "System" : d.sender;
    vnText.textContent = "";
    if (isSys) { avatar.style.display = "none"; }
    else { avatar.src = avatarOr(d.avatar_url); fixImg(avatar); avatar.style.display = "block"; }
    if (d.is_interrupt) shake();
    highlightSpeaker(d.sender);

    const logText = appendChatRow(d);
    scrollChat();

    const job = { done: false, timer: null };
    const complete = () => {
        if (d.rich) vnText.innerHTML = d.text; else vnText.textContent = d.text;
    };
    job.finish = () => {
        if (job.done) return;
        job.done = true;
        clearTimeout(job.timer);
        complete();
        S.job = null;
        S.fadeTimer = setTimeout(() => box.classList.add("idle"), 15000);
        pump();
    };
    job.cancel = () => { job.done = true; clearTimeout(job.timer); S.job = null; };

    if (d.rich) {            // ข้อความจากระบบ (ผลทอยเต๋า) แสดงทันที
        complete();
        job.timer = setTimeout(job.finish, 600);
        return job;
    }

    const chars = Array.from(d.text);
    const speed = d.is_interrupt ? 12 : 32;
    const pitch = d.is_interrupt ? 600 : (isSys ? 300 : 450);
    let i = 0;
    const step = () => {
        if (job.done) return;
        if (i >= chars.length) return job.finish();
        const ch = chars[i++];
        vnText.textContent += ch;
        if (ch.trim() && i % 2 === 0) playBlip(pitch);
        job.timer = setTimeout(step, speed);
    };
    step();
    return job;
}

// ------------------------------------------------------------------ DM tools
function dm(command, extra = {}) { send({ type: "dm_command", command, ...extra }); }
function dmSpeak(interrupt) {
    const input = $("dm-sys-msg");
    const text = input.value.trim();
    if (!text) return;
    send({
        type: "chat", text, is_interrupt: interrupt,
        override_name: $("dm-rp-name").value.trim() || "DM",
        override_avatar: $("dm-rp-avatar").value.trim(),
    });
    input.value = "";
}

function makeDraggable(panel, handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener("pointerdown", (e) => {
        dragging = true;
        const r = panel.getBoundingClientRect();
        ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
        panel.style.left = ox + "px"; panel.style.top = oy + "px"; panel.style.right = "auto";
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        panel.style.left = Math.max(0, Math.min(innerWidth - 80, ox + e.clientX - sx)) + "px";
        panel.style.top = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy)) + "px";
    });
    const stop = () => { dragging = false; };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
}

// ------------------------------------------------------------------ wiring
function sendChat() {
    const input = $("player-msg");
    const text = input.value.trim();
    if (!text) return;
    if (send({ type: "chat", text })) input.value = "";
}

document.addEventListener("DOMContentLoaded", () => {
    // auth
    $("login-btn").onclick = login;
    $("register-btn").onclick = register;
    $("to-register").onclick = () => { setAuthMsg(""); showAuth(true); };
    $("to-login").onclick = () => { setAuthMsg(""); showAuth(false); };
    ["login-user", "login-pass"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") login(); }));
    ["reg-user", "reg-pass", "reg-avatar"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") register(); }));

    // account
    $("acc-btn").onclick = () => {
        if (!S.me) return;
        $("acc-name").textContent = S.me.username;
        $("acc-rank").textContent = S.me.rank;
        $("acc-avatar").src = avatarOr(S.me.avatar_url); fixImg($("acc-avatar"));
        $("account-modal").style.display = "flex";
    };
    $("acc-close").onclick = () => { $("account-modal").style.display = "none"; };
    $("logout-btn").onclick = logout;

    // chat
    $("send-btn").onclick = sendChat;
    $("player-msg").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendChat(); }
    });
    document.querySelectorAll("[data-dice]").forEach((b) => {
        b.onclick = () => send({ type: "roll", dice: parseInt(b.dataset.dice, 10) });
    });
    $("vn-dialog-box").onclick = () => { if (S.job) S.job.finish(); };

    // status / scene
    ["hp-val", "sp-val"].forEach((id) => $(id).addEventListener("change", sendMyStatus));
    $("enter-left").onclick = () => send({ type: "enter_scene", slot: "left" });
    $("enter-right").onclick = () => send({ type: "enter_scene", slot: "right" });
    $("leave-scene").onclick = () => send({ type: "leave_scene" });

    // QTE
    $("qte-btn").onclick = () => {
        clearTimeout(S.qteTimer);
        $("qte-overlay").style.display = "none";
        send({ type: "qte_result", ok: true });
    };

    // sound
    $("vol").value = S.volume;
    $("vol").oninput = () => { S.volume = parseInt($("vol").value, 10); lstore("trpg_vol", String(S.volume)); applyVolume(); };
    $("mute-btn").onclick = () => { S.muted = !S.muted; lstore("trpg_muted", S.muted ? "1" : "0"); applyVolume(); };
    applyVolume();

    // panels
    document.querySelectorAll("[data-collapse]").forEach((head) => {
        head.onclick = () => {
            const panel = head.parentElement;
            const collapsed = panel.classList.toggle("collapsed");
            document.body.classList.toggle(head.dataset.collapse + "-collapsed", collapsed);
            head.querySelector(".chev").textContent = collapsed ? "+" : "–";
        };
    });
    if (window.matchMedia("(max-width: 860px)").matches) {
        document.querySelectorAll("[data-collapse]").forEach((h) => h.click());
    }
    const toggleUi = () => document.body.classList.toggle("ui-hidden");
    $("ui-toggle").onclick = toggleUi;
    window.addEventListener("keydown", (e) => {
        const t = e.target.tagName;
        if ((e.key === "h" || e.key === "H") && t !== "INPUT" && t !== "SELECT" && t !== "TEXTAREA") toggleUi();
    });

    // DM
    makeDraggable($("dm-panel"), $("dm-head"));
    $("dm-narrate").onclick = () => dmSpeak(false);
    $("dm-interrupt").onclick = () => dmSpeak(true);
    $("dm-sys-msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) dmSpeak(false); });
    $("dm-bg-btn").onclick = () => dm("change_bg", { url: $("dm-bg").value.trim() });
    $("dm-bgm-play").onclick = () => dm("play_yt_bgm", { yt_id: $("dm-yt").value.trim() });
    $("dm-bgm-stop").onclick = () => dm("stop_bgm");
    $("dm-choices-send").onclick = () => {
        const choices = [1, 2, 3, 4].map((n) => $("dm-choice-" + n).value.trim()).filter(Boolean);
        dm("show_choices", { choices });
    };
    $("dm-choices-clear").onclick = () => dm("clear_choices");
    $("dm-qte-send").onclick = () => dm("start_qte", { action: $("dm-qte-name").value, time_limit: parseInt($("dm-qte-time").value, 10) || 3 });
    $("dm-shake").onclick = () => dm("trigger_vfx", { effect: "screen_shake" });
    $("dm-clear-scene").onclick = () => dm("clear_scene");
    $("dm-roll").onclick = () => dm("roll_dice", { dice_type: parseInt($("dm-dice").value, 10) });
    $("dm-target").onchange = fillDmStatus;
    $("dm-status-apply").onclick = () => dm("set_status", {
        target: $("dm-target").value,
        hp: $("dm-hp").value, sp: $("dm-sp").value,
        max_hp: $("dm-maxhp").value, max_sp: $("dm-maxsp").value,
    });

    // auto login ด้วย token เดิม (รีเฟรชหน้าแล้วไม่ต้องล็อกอินใหม่)
    if (S.token) connect(); else showAuth(false);
});
