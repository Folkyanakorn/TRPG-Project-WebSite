import html
import json
import random
import re
import secrets
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import database
from models import UserAuth
from room_manager import RoomManager

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI()
room = RoomManager()
database.init_db()

sessions: dict = {}  # token -> username

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ------------------------------------------------------------------ helpers
NAME_RE = re.compile(r"^[\w฀-๿ .\-]{2,24}$")
RESERVED_NAMES = {"system", "dm"}
YT_RE = re.compile(r"(?:youtu\.be/|youtube\.com/(?:embed/|v/|shorts/|watch\?(?:.*&)?v=))([\w-]{11})")
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")


def extract_video_id(raw: str):
    raw = (raw or "").strip()
    match = YT_RE.search(raw)
    if match:
        return match.group(1)
    return raw if VIDEO_ID_RE.match(raw) else None


def clean_url(raw, allow_relative=False):
    raw = (raw or "").strip()
    if not raw or len(raw) > 1000:
        return ""
    if raw.startswith(("http://", "https://")):
        return raw
    if allow_relative and raw.startswith("/static/"):
        return raw
    return ""


def to_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------ REST
@app.post("/register")
async def api_register(user: UserAuth):
    username = user.username.strip()
    if not NAME_RE.match(username):
        raise HTTPException(400, "ชื่อบัญชีต้องยาว 2-24 ตัว (ไทย/อังกฤษ/ตัวเลข/จุด/ขีด)")
    if username.lower() in RESERVED_NAMES:
        raise HTTPException(400, "ชื่อนี้ถูกจองไว้สำหรับระบบ")
    if len(user.password) < 4:
        raise HTTPException(400, "รหัสผ่านต้องยาวอย่างน้อย 4 ตัว")
    avatar = clean_url(user.avatar_url, allow_relative=True)
    if user.avatar_url and not avatar:
        raise HTTPException(400, "ลิงก์ภาพโปรไฟล์ต้องขึ้นต้นด้วย http:// หรือ https://")
    if not database.register_user(username, user.password, avatar):
        raise HTTPException(400, "ชื่อนี้มีคนใช้แล้ว")
    return {"message": "สมัครสมาชิกสำเร็จ! เข้าสู่ระบบได้เลย"}


@app.post("/login")
async def api_login(user: UserAuth):
    result = database.login_user(user.username.strip(), user.password)
    if not result["success"]:
        raise HTTPException(401, "ชื่อบัญชีหรือรหัสผ่านไม่ถูกต้อง")
    token = secrets.token_urlsafe(24)
    sessions[token] = result["username"]
    return {
        "message": "เข้าสู่ระบบสำเร็จ",
        "token": token,
        "username": result["username"],
        "avatar_url": result["avatar_url"],
        "rank": result["rank"],
    }


@app.post("/logout")
async def api_logout(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    username = sessions.pop(str((body or {}).get("token", "")), None)
    if username and room.leave_scene(username):
        await room.broadcast_scene()
    return {"ok": True}


@app.get("/account/{username}")
async def get_account(username: str):
    info = database.get_user_info(username)
    if info:
        return {"avatar_url": info["avatar_url"], "rank": info["rank"]}
    raise HTTPException(404, "User not found")


@app.get("/")
async def get_player_screen():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


# ------------------------------------------------------------------ WebSocket
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = ""):
    await websocket.accept()

    username = sessions.get(token)
    info = database.get_user_info(username) if username else None
    if not info:
        await websocket.send_text(json.dumps({"type": "auth_error"}))
        await websocket.close(code=4401)
        return

    client = room.connect(websocket, info)
    await room.send(websocket, room.init_payload(client))
    await room.broadcast_presence()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(payload, dict):
                continue
            try:
                await handle_message(websocket, client, payload)
            except Exception:
                traceback.print_exc()
                await room.send(websocket, {"type": "error", "message": "เซิร์ฟเวอร์ประมวลผลคำสั่งไม่ได้"})
    except WebSocketDisconnect:
        pass
    finally:
        await room.disconnect(websocket)


async def err(ws, message: str):
    await room.send(ws, {"type": "error", "message": message})


async def handle_message(ws, client: dict, p: dict):
    kind = p.get("type")
    name = client["username"]
    is_admin = client["is_admin"]

    if kind == "chat":
        text = str(p.get("text", "")).strip()[:500]
        if not text:
            return
        sender, avatar, interrupt = name, client["avatar_url"], False
        if is_admin:  # เฉพาะ DM เท่านั้นที่สวมบทบาท/แทรกคิวได้
            override = str(p.get("override_name") or "").strip()[:30]
            if override:
                sender = override
                avatar = clean_url(p.get("override_avatar"))
            interrupt = bool(p.get("is_interrupt"))
        await room.chat(sender, text, avatar, interrupt)

    elif kind == "roll":
        await do_roll(name, to_int(p.get("dice"), 20))

    elif kind == "enter_scene":
        error = room.enter_scene(name, client["avatar_url"], str(p.get("slot")))
        if error:
            return await err(ws, error)
        await room.broadcast_scene()
        await room.chat("System", f"{name} เดินเข้าสู่ฉาก")

    elif kind == "leave_scene":
        if room.leave_scene(name):
            await room.broadcast_scene()
            await room.chat("System", f"{name} เดินออกจากฉาก")

    elif kind == "set_status":
        room.update_status(name, hp=to_int(p.get("hp")), sp=to_int(p.get("sp")))
        await room.broadcast_presence()

    elif kind == "choice":
        text = str(p.get("text", "")).strip()[:80]
        if text:
            await room.chat(name, f"[เลือก] {text}", client["avatar_url"])

    elif kind == "qte_result":
        action = room.finish_qte(name)
        if action:
            result = "ทำสำเร็จ" if p.get("ok") else "ไม่ทัน"
            await room.chat("System", f"{name} {result}: {action}")

    elif kind == "dm_command":
        if not is_admin:
            return await err(ws, "เฉพาะ DM เท่านั้นที่ใช้คำสั่งนี้ได้")
        await handle_dm(ws, p)


async def do_roll(name: str, dice: int):
    dice = max(2, min(1000, dice or 20))
    result = random.randint(1, dice)
    note = ""
    if dice == 20 and result == 20:
        note = " (Critical!)"
    elif dice == 20 and result == 1:
        note = " (Fumble...)"
    text = f'{html.escape(name)} ทอย D{dice} ได้ <span class="dice-num">{result}</span>{note}'
    await room.chat("System", text, rich=True)


async def handle_dm(ws, p: dict):
    cmd = p.get("command")

    if cmd == "play_yt_bgm":
        yt_id = extract_video_id(str(p.get("yt_id", "")))
        if not yt_id:
            return await err(ws, "ลิงก์ YouTube ไม่ถูกต้อง")
        room.state["bgm"] = yt_id
        await room.broadcast({"type": "play_audio", "yt_id": yt_id})

    elif cmd == "stop_bgm":
        room.state["bgm"] = None
        await room.broadcast({"type": "stop_audio"})

    elif cmd == "change_bg":
        url = clean_url(p.get("url"), allow_relative=True)
        if not url:
            return await err(ws, "ลิงก์ภาพฉากหลังไม่ถูกต้อง")
        room.state["bg"] = url
        await room.broadcast({"type": "bg_control", "url": url})

    elif cmd == "trigger_vfx":
        await room.broadcast({"type": "vfx", "effect": "screen_shake"})

    elif cmd == "start_qte":
        action = str(p.get("action", "")).strip()[:60] or "QTE!"
        seconds = max(1.0, min(30.0, float(to_int(p.get("time_limit"), 3))))
        room.start_qte(action, seconds)
        await room.broadcast({"type": "qte_start", "action": action, "time_limit": seconds})

    elif cmd == "show_choices":
        raw = p.get("choices") if isinstance(p.get("choices"), list) else []
        choices = [str(c).strip()[:80] for c in raw if str(c).strip()][:4]
        if len(choices) < 2:
            return await err(ws, "ต้องมีตัวเลือกอย่างน้อย 2 ข้อ")
        await room.broadcast({"type": "choices_display", "choices": choices})

    elif cmd == "clear_choices":
        await room.broadcast({"type": "choices_clear"})

    elif cmd == "clear_scene":
        room.clear_scene()
        await room.broadcast_scene()

    elif cmd == "roll_dice":
        await do_roll("DM", to_int(p.get("dice_type"), 20))

    elif cmd == "set_status":
        target = str(p.get("target", ""))
        ok = room.update_status(
            target,
            max_hp=to_int(p.get("max_hp")), max_sp=to_int(p.get("max_sp")),
            hp=to_int(p.get("hp")), sp=to_int(p.get("sp")),
        )
        if not ok:
            return await err(ws, "ไม่พบผู้เล่นคนนี้")
        await room.broadcast_presence()
