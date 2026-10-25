from typing import Dict, List, Any
import json

class RoomManager:
    def __init__(self):
        self.active_connections: List[Any] = []

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_text(json.dumps(message))
            except:
                pass
