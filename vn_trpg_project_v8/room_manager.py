import asyncio
import json
import time
from collections import deque
from typing import Any, Dict, Optional

import database

SIDES = ("left", "right")


class RoomManager:
    """เก็บสถานะห้องเกมทั้งหมดไว้ในหน่วยความจำ (เซิร์ฟเวอร์เดียว ห้องเดียว)"""

    def __init__(self):
        self.clients: Dict[Any, dict] = {}          # websocket -> ข้อมูลผู้ใช้
        self.status: Dict[str, dict] = {}           # username -> hp/sp/max
        self.history: deque = deque(maxlen=60)      # แชทล่าสุด (ส่งให้คนเข้าทีหลัง)
        self.state = {"bg": None, "bgm": None, "slots": {"left": None, "right": None}}
        self.qte: Optional[dict] = None

    # ---------- connection ----------
    def connect(self, ws, info: dict) -> dict:
        client = {
            "username": info["username"],
            "avatar_url": info["avatar_url"],
            "rank": info["rank"],
            "is_admin": info["username"].lower() == "admin",
        }
        self.clients[ws] = client
        self.status.setdefault(
            info["username"],
            {k: info[k] for k in ("hp", "sp", "max_hp", "max_sp")},
        )
        return client

    async def disconnect(self, ws):
        client = self.clients.pop(ws, None)
        if not client:
            return
        name = client["username"]
        if not self.is_online(name):
            # ผ่อนผัน 20 วินาที เผื่อรีเฟรชหน้า/เน็ตกระตุก แล้วค่อยเอาออกจากฉาก
            asyncio.create_task(self._delayed_leave(name))
        await self.broadcast_presence()

    async def _delayed_leave(self, name: str, delay: float = 20.0):
        await asyncio.sleep(delay)
        if not self.is_online(name) and self.leave_scene(name):
            await self.broadcast_scene()

    def is_online(self, username: str) -> bool:
        return any(c["username"] == username for c in self.clients.values())

    def find_ws(self, username: str):
        return [ws for ws, c in self.clients.items() if c["username"] == username]

    # ---------- sending ----------
    async def send(self, ws, message: dict):
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            self.clients.pop(ws, None)

    async def broadcast(self, message: dict):
        data = json.dumps(message)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)

    # ---------- presence / status ----------
    def users_payload(self) -> list:
        seen: Dict[str, dict] = {}
        for c in self.clients.values():
            name = c["username"]
            if name in seen:
                continue
            st = self.status.get(name, {})
            seen[name] = {
                "username": name,
                "avatar_url": c["avatar_url"],
                "rank": c["rank"],
                "is_admin": c["is_admin"],
                "hp": st.get("hp", 100),
                "sp": st.get("sp", 100),
                "max_hp": st.get("max_hp", 100),
                "max_sp": st.get("max_sp", 100),
            }
        return sorted(seen.values(), key=lambda u: (not u["is_admin"], u["username"].lower()))

    async def broadcast_presence(self):
        await self.broadcast({"type": "presence", "users": self.users_payload()})

    def update_status(self, username: str, **fields):
        st = self.status.get(username)
        if st is None:
            info = database.get_user_info(username)
            if not info:
                return False
            st = self.status[username] = {k: info[k] for k in ("hp", "sp", "max_hp", "max_sp")}
        for key in ("max_hp", "max_sp"):
            if fields.get(key) is not None:
                st[key] = max(1, min(9999, int(fields[key])))
        for key, cap in (("hp", "max_hp"), ("sp", "max_sp")):
            if fields.get(key) is not None:
                st[key] = max(0, min(st[cap], int(fields[key])))
        # ถ้าลด max ลงต่ำกว่าค่าปัจจุบัน ให้ตัดค่าปัจจุบันตาม
        st["hp"] = min(st["hp"], st["max_hp"])
        st["sp"] = min(st["sp"], st["max_sp"])
        database.save_status(username, st["hp"], st["sp"], st["max_hp"], st["max_sp"])
        return True

    # ---------- scene ----------
    def enter_scene(self, username: str, avatar: str, side: str) -> Optional[str]:
        if side not in SIDES:
            return "ช่องฉากไม่ถูกต้อง"
        occupant = self.state["slots"][side]
        if occupant and occupant["user"] != username:
            return f"ช่อง{'ซ้าย' if side == 'left' else 'ขวา'}มี {occupant['user']} ยืนอยู่แล้ว"
        self.leave_scene(username)
        self.state["slots"][side] = {"user": username, "avatar": avatar}
        return None

    def leave_scene(self, username: str) -> bool:
        changed = False
        for side in SIDES:
            slot = self.state["slots"][side]
            if slot and slot["user"] == username:
                self.state["slots"][side] = None
                changed = True
        return changed

    def clear_scene(self):
        self.state["slots"] = {"left": None, "right": None}

    async def broadcast_scene(self):
        await self.broadcast({"type": "scene_state", "slots": self.state["slots"]})

    # ---------- chat ----------
    async def chat(self, sender: str, text: str, avatar_url: str = "",
                   is_interrupt: bool = False, rich: bool = False):
        data = {
            "sender": sender,
            "text": text,
            "avatar_url": avatar_url,
            "is_interrupt": is_interrupt,
            "rich": rich,
        }
        self.history.append(data)
        await self.broadcast({"type": "chat_render", "data": data})

    # ---------- init payload ----------
    def init_payload(self, client: dict) -> dict:
        return {
            "type": "init",
            "me": {**client, **self.status.get(client["username"], {})},
            "state": self.state,
            "history": list(self.history),
            "users": self.users_payload(),
        }

    # ---------- qte ----------
    def start_qte(self, action: str, seconds: float):
        self.qte = {"action": action, "until": time.time() + seconds + 2.0, "done": set()}

    def finish_qte(self, username: str) -> Optional[str]:
        q = self.qte
        if not q or time.time() > q["until"] or username in q["done"]:
            return None
        q["done"].add(username)
        return q["action"]
