import sqlite3

DB_NAME = "trpg.db"

def init_db():
    with sqlite3.connect(DB_NAME) as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY, 
                password TEXT, 
                avatar_url TEXT
            )
        ''')
        # Attempt to add rank column if updating from old DB
        try:
            conn.execute("ALTER TABLE users ADD COLUMN rank TEXT DEFAULT 'พลทหาร (Rookie)'")
        except:
            pass
        conn.commit()

def register_user(username, password, avatar_url):
    with sqlite3.connect(DB_NAME) as conn:
        try:
            conn.execute(
                "INSERT INTO users (username, password, avatar_url, rank) VALUES (?, ?, ?, 'พลทหาร (Rookie)')", 
                (username, password, avatar_url)
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

def login_user(username, password):
    with sqlite3.connect(DB_NAME) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT avatar_url, rank FROM users WHERE username=? AND password=?", 
            (username, password)
        )
        result = cursor.fetchone()
        if result:
            return {"success": True, "avatar_url": result[0], "rank": result[1]}
        return {"success": False}
        
def get_user_info(username):
    with sqlite3.connect(DB_NAME) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT avatar_url, rank FROM users WHERE username=?", (username,))
        result = cursor.fetchone()
        if result:
            return {"avatar_url": result[0], "rank": result[1]}
        return None
