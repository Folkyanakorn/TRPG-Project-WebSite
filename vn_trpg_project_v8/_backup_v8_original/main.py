from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from room_manager import RoomManager
from models import UserAuth
import database
import json
import random

app = FastAPI()
room = RoomManager()
database.init_db()

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.post("/register")
async def api_register(user: UserAuth):
    success = database.register_user(user.username, user.password, user.avatar_url)
    if success:
        return {"message": "สมัครสมาชิกสำเร็จ!"}
    raise HTTPException(status_code=400, detail="ชื่อผู้ใช้นี้ถูกใช้งานแล้ว")

@app.post("/login")
async def api_login(user: UserAuth):
    result = database.login_user(user.username, user.password)
    if result["success"]:
        return {"message": "เข้าสู่ระบบสำเร็จ", "avatar_url": result["avatar_url"], "rank": result["rank"]}
    raise HTTPException(status_code=401, detail="ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")

@app.get("/account/{username}")
async def get_account(username: str):
    info = database.get_user_info(username)
    if info:
        return info
    raise HTTPException(status_code=404, detail="User not found")

@app.get("/")
async def get_player_screen():
    # Only one screen needed now
    return FileResponse("static/index.html")

@app.websocket("/ws/{client_name}")
async def websocket_endpoint(websocket: WebSocket, client_name: str):
    await websocket.accept()
    room.active_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            msg_type = payload.get("type")
            
            if msg_type == "chat":
                await room.broadcast({
                    "type": "chat_render",
                    "data": {
                        "sender": payload.get("override_name", client_name), 
                        "text": payload["text"], 
                        "is_interrupt": payload.get("is_interrupt", False),
                        "avatar_url": payload.get("avatar_url", "")
                    }
                })
            elif msg_type == "dm_command" and (client_name == "admin" or payload.get("force")):
                cmd = payload["command"]
                if cmd == "play_yt_bgm":
                    await room.broadcast({"type": "play_audio", "yt_id": payload["yt_id"]})
                elif cmd == "change_bg":
                    await room.broadcast({"type": "bg_control", "url": payload["url"]})
                elif cmd == "trigger_vfx":
                    await room.broadcast({"type": "vfx", "effect": payload["effect"]})
                elif cmd == "start_qte":
                    await room.broadcast({"type": "qte_start", "action": payload["action"], "time_limit": payload["time_limit"]} )
                elif cmd == "roll_dice":
                    dice_type = int(payload.get("dice_type", 20))
                    result = random.randint(1, dice_type)
                    msg = f"🎲 ทอยลูกเต๋า D{dice_type} ได้ผลลัพธ์: <span style='font-size:1.5em; color:#f1c40f;'>{result}</span>"
                    await room.broadcast({
                        "type": "chat_render",
                        "data": {"sender": "System", "text": msg, "is_interrupt": False, "avatar_url": "https://cdn-icons-png.flaticon.com/512/8002/8002130.png"}
                    })
                elif cmd == "show_choices":
                    await room.broadcast({"type": "choices_display", "choices": payload["choices"]})
                elif cmd == "clear_scene":
                    await room.broadcast({"type": "scene_control", "action": "clear"})
            
            elif msg_type == "scene_control":
                # Anyone can enter/leave scene
                await room.broadcast(payload)
                
            elif msg_type == "status_update":
                # A player broadcasts their own status update (if needed for DM to see, currently local UI mostly, but good for logs)
                pass

    except WebSocketDisconnect:
        room.active_connections.remove(websocket)
