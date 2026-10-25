let socket;
let currentUser = "";
let currentAvatar = "";
let currentRank = "";
let bgmPlayer;
let messageQueue = [];
let isTyping = false;

// Audio
let audioCtx;
function initAudio() {
    if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    if (audioCtx.state === 'suspended') { audioCtx.resume(); }
}
function playBlip(pitch = 450) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(pitch, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.015, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.03);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.03);
}

// YT Parser
function extractVideoID(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return match ? match[1] : url; // If regex fails, assume they pasted the ID directly
}

// Auth
function toggleAuth() {
    const loginBox = document.getElementById('login-box');
    const regBox = document.getElementById('register-box');
    if (loginBox.style.display === "none") {
        loginBox.style.display = "block"; regBox.style.display = "none";
    } else {
        loginBox.style.display = "none"; regBox.style.display = "block";
    }
}

async function register() {
    const user = document.getElementById('reg-user').value;
    const pass = document.getElementById('reg-pass').value;
    const avatar = document.getElementById('reg-avatar').value;
    if(!user || !pass) return alert("กรุณากรอกชื่อและรหัสผ่าน");
    
    const res = await fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass, avatar_url: avatar })
    });
    const data = await res.json();
    if (res.ok) { alert(data.message); toggleAuth(); } 
    else { alert(data.detail); }
}

async function login() {
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    if(!user || !pass) return alert("กรุณากรอกชื่อและรหัสผ่าน");
    
    const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    
    if (res.ok) {
        currentUser = user;
        currentAvatar = data.avatar_url || "https://cdn-icons-png.flaticon.com/512/149/149071.png";
        currentRank = data.rank;
        
        document.getElementById('auth-screen').style.display = 'none';
        
        // Show DM Panel if admin
        if(currentUser.toLowerCase() === 'admin') {
            document.getElementById('dm-panel').style.display = 'block';
            // Drag logic for DM panel
            dragElement(document.getElementById("dm-panel"));
        }
        
        initAudio();
        initWebSocket();
    } else { alert(data.detail); }
}

function showAccount() {
    document.getElementById('account-modal').style.display = 'flex';
    document.getElementById('acc-name').innerText = currentUser;
    document.getElementById('acc-avatar').src = currentAvatar;
    document.getElementById('acc-rank').innerText = currentRank;
}

// WebSocket & Game Logic
function onYouTubeIframeAPIReady() {
    bgmPlayer = new YT.Player('yt-player', { height: '10', width: '10', playerVars: { 'autoplay': 0, 'controls': 0 } });
}

function initWebSocket() {
    socket = new WebSocket(`ws://${window.location.host}/ws/${currentUser}`);
    socket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        
        if (payload.type === "chat_render") {
            if (payload.data.is_interrupt) { messageQueue.unshift(payload); } 
            else { messageQueue.push(payload); }
            processQueue();
        } 
        else if (payload.type === "vfx" && payload.effect === "screen_shake") {
            document.body.classList.add("shake");
            setTimeout(() => document.body.classList.remove("shake"), 400);
        }
        else if (payload.type === "play_audio" && bgmPlayer && bgmPlayer.loadVideoById) {
            bgmPlayer.loadVideoById({'videoId': payload.yt_id});
        }
        else if (payload.type === "bg_control") {
            document.getElementById('vn-screen').style.backgroundImage = `url('${payload.url}')`;
        }
        else if (payload.type === "qte_start") {
            const qteOverlay = document.getElementById('qte-overlay');
            document.getElementById('qte-title').innerText = payload.action;
            qteOverlay.style.display = "block";
            setTimeout(() => { qteOverlay.style.display = "none"; }, payload.time_limit * 1000);
        }
        else if (payload.type === "choices_display") {
            const container = document.getElementById('choices-container');
            container.innerHTML = "";
            payload.choices.forEach(c => {
                if(c.trim() !== "") {
                    let btn = document.createElement("button");
                    btn.className = "choice-btn";
                    btn.innerText = c;
                    btn.onclick = () => {
                        document.getElementById('choices-overlay').style.display = "none";
                        socket.send(JSON.stringify({ type: "chat", text: `[เลือก]: ${c}`, is_interrupt: false, avatar_url: currentAvatar }));
                    };
                    container.appendChild(btn);
                }
            });
            document.getElementById('choices-overlay').style.display = "block";
        }
        else if (payload.type === "scene_control") {
            const slotL = document.getElementById('slot-left');
            const slotR = document.getElementById('slot-right');
            const imgL = document.getElementById('img-left');
            const imgR = document.getElementById('img-right');
            
            if(payload.action === "enter") {
                if(payload.slot === "left") {
                    imgL.src = payload.avatar;
                    slotL.classList.add('show-left');
                } else {
                    imgR.src = payload.avatar;
                    slotR.classList.add('show-right');
                }
            } else if (payload.action === "leave") {
                if(payload.slot === "left") slotL.classList.remove('show-left');
                if(payload.slot === "right") slotR.classList.remove('show-right');
            } else if (payload.action === "clear") {
                slotL.classList.remove('show-left');
                slotR.classList.remove('show-right');
            }
        }
    };
}

// Scene Mechanics (Player Side)
function enterScene(slot) {
    if(!socket) return;
    socket.send(JSON.stringify({ type: "scene_control", action: "enter", slot: slot, avatar: currentAvatar }));
    socket.send(JSON.stringify({ type: "chat", text: `*เดินเข้าสู่ฉาก*`, avatar_url: currentAvatar }));
}
function leaveScene() {
    if(!socket) return;
    // tell all slots just in case
    socket.send(JSON.stringify({ type: "scene_control", action: "leave", slot: "left" }));
    socket.send(JSON.stringify({ type: "scene_control", action: "leave", slot: "right" }));
    socket.send(JSON.stringify({ type: "chat", text: `*เดินออกจากฉากไป*`, avatar_url: currentAvatar }));
}

// Chat Typewriter
function processQueue() {
    if (isTyping || messageQueue.length === 0) return;
    isTyping = true;
    
    const payload = messageQueue.shift();
    let displayAvatar = payload.data.avatar_url;
    let senderName = payload.data.sender;
    
    // Admin Override display logic
    if(!displayAvatar || senderName === "System") {
        displayAvatar = "https://cdn-icons-png.flaticon.com/512/8002/8002130.png"; // Default system icon
    }
    
    // VN Window Update
    const vnDialog = document.getElementById('vn-dialog-box');
    const vnName = document.getElementById('vn-dialog-name');
    const vnText = document.getElementById('vn-dialog-text');
    const vnAvatar = document.getElementById('vn-dialog-avatar');
    
    vnDialog.style.display = 'flex';
    vnName.innerText = senderName;
    vnName.style.color = payload.data.is_interrupt ? "#ff4444" : "#f1c40f";
    vnText.innerHTML = "";
    
    if(senderName === "System") { vnAvatar.style.display = "none"; } 
    else { vnAvatar.src = displayAvatar; vnAvatar.style.display = "block"; }
    
    if (payload.data.is_interrupt) {
        vnDialog.style.borderColor = "#ff4444";
        document.body.classList.add("shake");
        setTimeout(() => document.body.classList.remove("shake"), 400);
    } else {
        vnDialog.style.borderColor = "#ecf0f1";
    }

    // Chat Log Update
    const chatBox = document.getElementById('chat-history');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';
    msgDiv.innerHTML = `
        <img src="${displayAvatar}" class="chat-avatar" ${senderName === "System" ? 'style="display:none;"' : ''}>
        <div class="chat-content">
            <div class="chat-name" style="color: ${payload.data.is_interrupt ? '#ff4444' : '#f1c40f'};">${senderName}</div>
            <span class="chat-history-text" style="color: ${payload.data.is_interrupt ? '#ff4444' : 'white'};"></span>
        </div>
    `;
    chatBox.appendChild(msgDiv);
    const historySpan = msgDiv.querySelector('.chat-history-text');

    let i = 0;
    const text = payload.data.text;
    const typeSpeed = payload.data.is_interrupt ? 10 : 35; 
    const pitch = payload.data.is_interrupt ? 600 : (senderName === "System" ? 300 : 450);

    function typeWriter() {
        if (i < text.length) {
            if (text.charAt(i) === '<') {
                let tag = "";
                while (text.charAt(i) !== '>' && i < text.length) { tag += text.charAt(i); i++; }
                if (i < text.length) { tag += text.charAt(i); i++; }
                vnText.innerHTML += tag; historySpan.innerHTML += tag;
            } else {
                vnText.innerHTML += text.charAt(i);
                historySpan.innerHTML += text.charAt(i);
                if (text.charAt(i) !== ' ' && i % 2 === 0) { playBlip(pitch); }
                i++;
            }
            chatBox.scrollTop = chatBox.scrollHeight;
            setTimeout(typeWriter, typeSpeed);
        } else {
            isTyping = false;
            processQueue();
        }
    }
    typeWriter();
}

// Player Inputs
document.getElementById('send-btn').addEventListener('click', () => {
    const msg = document.getElementById('player-msg').value;
    if(msg && socket) {
        socket.send(JSON.stringify({ type: "chat", text: msg, is_interrupt: false, avatar_url: currentAvatar }));
        document.getElementById('player-msg').value = '';
    }
});
document.getElementById("player-msg").addEventListener("keypress", (e) => {
    if (e.key === "Enter") document.getElementById("send-btn").click();
});
document.getElementById('qte-btn').addEventListener('click', () => {
    document.getElementById('qte-overlay').style.display = "none";
    socket.send(JSON.stringify({ type: "chat", text: "[QTE สำเร็จ!] โต้ตอบทันเวลา!", avatar_url: currentAvatar }));
});

// ---------------------------
// 3. DM Tools Functions
// ---------------------------
function dmPlayBGM() {
    const raw = document.getElementById('dm-yt').value;
    const id = extractVideoID(raw);
    socket.send(JSON.stringify({ type: "dm_command", command: "play_yt_bgm", yt_id: id }));
}
function dmChangeBG() {
    const url = document.getElementById('dm-bg').value;
    socket.send(JSON.stringify({ type: "dm_command", command: "change_bg", url: url }));
}
function dmVFXShake() {
    socket.send(JSON.stringify({ type: "dm_command", command: "trigger_vfx", effect: "screen_shake" }));
}
function dmClearScene() {
    socket.send(JSON.stringify({ type: "dm_command", command: "clear_scene" }));
}
function dmSendChoices() {
    const c1 = document.getElementById('dm-choice-1').value;
    const c2 = document.getElementById('dm-choice-2').value;
    socket.send(JSON.stringify({ type: "dm_command", command: "show_choices", choices: [c1, c2] }));
}
function dmSendQTE() {
    const title = document.getElementById('dm-qte-name').value;
    socket.send(JSON.stringify({ type: "dm_command", command: "start_qte", action: title, time_limit: 3 }));
}
function dmInterrupt() {
    const msg = document.getElementById('dm-sys-msg').value;
    const roleName = document.getElementById('dm-rp-name').value || "DM (System)";
    if(msg) {
        // Send as chat but with override name
        socket.send(JSON.stringify({ type: "chat", text: msg, is_interrupt: true, override_name: roleName }));
        document.getElementById('dm-sys-msg').value = '';
    }
}

// Make DM Panel Draggable
function dragElement(elmnt) {
  var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  if (document.getElementById(elmnt.id + "header")) {
    document.getElementById(elmnt.id + "header").onmousedown = dragMouseDown;
  } else {
    elmnt.onmousedown = dragMouseDown;
  }
  function dragMouseDown(e) {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; // Don't drag if clicking input
    e = e || window.event;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }
  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
    elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
  }
  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}
