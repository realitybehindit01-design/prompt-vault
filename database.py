import sqlite3
import json
import os
import difflib
from datetime import datetime
from typing import List, Dict, Any, Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ORIGINAL_DB = os.path.join(BASE_DIR, "prompts.db")

# Vercel / AWS Lambda Serverless environment: use writable /tmp
if os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME") or not os.access(BASE_DIR, os.W_OK):
    import shutil
    tmp_db = "/tmp/prompts.db"
    if not os.path.exists(tmp_db):
        try:
            if os.path.exists(ORIGINAL_DB):
                shutil.copyfile(ORIGINAL_DB, tmp_db)
            if os.path.exists(tmp_db):
                os.chmod(tmp_db, 0o666)
        except Exception as e:
            print("[Database Warning] Could not copy DB to /tmp:", e)
    DB_FILE = tmp_db
else:
    DB_FILE = ORIGINAL_DB

def get_db_connection():
    if DB_FILE.startswith("/tmp"):
        try:
            os.makedirs("/tmp", exist_ok=True)
        except Exception:
            pass
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
    except Exception:
        pass
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Users Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """)

    # Seed Default User if empty
    cursor.execute("SELECT COUNT(*) as count FROM users")
    if cursor.fetchone()["count"] == 0:
        cursor.execute("""
        INSERT INTO users (id, username, email, password_hash, created_at)
        VALUES (1, 'default_user', 'user@promptvault.local', 'local_authenticated', ?)
        """, (datetime.now().isoformat(),))

    # 2. Categories Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        icon TEXT DEFAULT 'folder',
        color TEXT DEFAULT 'indigo'
    )
    """)

    # 3. Projects Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 1,
        name TEXT NOT NULL,
        client TEXT DEFAULT '',
        description TEXT DEFAULT '',
        category TEXT DEFAULT 'General',
        icon TEXT DEFAULT 'briefcase',
        color TEXT DEFAULT 'indigo',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """)

    # 4. Folders Table (Supports Nested Subfolders via parent_id)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 1,
        project_id INTEGER DEFAULT NULL,
        parent_id INTEGER DEFAULT NULL,
        name TEXT NOT NULL,
        icon TEXT DEFAULT 'folder',
        color TEXT DEFAULT 'indigo',
        position INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
        FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE
    )
    """)

    # 5. Prompts Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 1,
        folder_id INTEGER DEFAULT NULL,
        project_id INTEGER DEFAULT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'General',
        ai_model TEXT DEFAULT 'General',
        system_prompt TEXT DEFAULT '',
        prompt_text TEXT NOT NULL,
        variables TEXT DEFAULT '[]',
        tags TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        is_favorite INTEGER DEFAULT 0,
        copy_count INTEGER DEFAULT 0,
        usage_count INTEGER DEFAULT 0,
        current_version INTEGER DEFAULT 1,
        last_used_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE SET NULL,
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
    )
    """)

    # Schema Migrations Check
    cursor.execute("PRAGMA table_info(prompts)")
    cols = [col["name"] for col in cursor.fetchall()]
    if "user_id" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN user_id INTEGER DEFAULT 1")
    if "folder_id" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN folder_id INTEGER DEFAULT NULL")
    if "project_id" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN project_id INTEGER DEFAULT NULL")
    if "usage_count" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN usage_count INTEGER DEFAULT 0")
    if "last_used_at" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN last_used_at TEXT DEFAULT NULL")
    if "is_deleted" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN is_deleted INTEGER DEFAULT 0")
    if "current_version" not in cols:
        cursor.execute("ALTER TABLE prompts ADD COLUMN current_version INTEGER DEFAULT 1")

    # 6. Prompt Versions / History Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS prompt_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL,
        version_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        ai_model TEXT DEFAULT 'General',
        system_prompt TEXT DEFAULT '',
        prompt_text TEXT NOT NULL,
        variables TEXT DEFAULT '[]',
        tags TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        change_summary TEXT DEFAULT 'Snapshot',
        created_at TEXT NOT NULL,
        FOREIGN KEY (prompt_id) REFERENCES prompts (id) ON DELETE CASCADE
    )
    """)

    conn.commit()

    # Seed Default Categories
    default_categories = [
        ("Marketing", "trending-up", "purple"),
        ("SEO", "search", "amber"),
        ("Social Media", "share-2", "blue"),
        ("Graphic Design", "palette", "pink"),
        ("Video Editing", "video", "red"),
        ("Image Generation", "image", "rose"),
        ("Video Generation", "film", "orange"),
        ("Copywriting", "pen-tool", "emerald"),
        ("Business", "briefcase", "indigo"),
        ("Research", "book-open", "cyan"),
        ("Programming", "code-2", "blue"),
        ("Fiverr", "dollar-sign", "emerald"),
        ("Personal", "user", "violet")
    ]

    for name, icon, color in default_categories:
        cursor.execute("INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)", (name, icon, color))

    conn.commit()
    conn.close()

# ==================== PROMPT OPERATIONS ====================

def get_all_prompts(
    user_id: int = 1,
    category: Optional[str] = None,
    folder_id: Optional[int] = None,
    project_id: Optional[int] = None,
    search: Optional[str] = None,
    favorite_only: bool = False,
    model: Optional[str] = None,
    recent_only: bool = False
) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()

    query = """
    SELECT p.*, f.name as folder_name, pr.name as project_name
    FROM prompts p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN projects pr ON p.project_id = pr.id
    WHERE p.user_id = ? AND p.is_deleted = 0
    """
    params: List[Any] = [user_id]

    if folder_id is not None:
        query += " AND p.folder_id = ?"
        params.append(folder_id)

    if project_id is not None:
        query += " AND p.project_id = ?"
        params.append(project_id)

    if category and category.lower() != "all":
        query += " AND p.category = ?"
        params.append(category)

    if favorite_only:
        query += " AND p.is_favorite = 1"

    if model and model.lower() != "all":
        query += " AND p.ai_model LIKE ?"
        params.append(f"%{model}%")

    if search:
        search_term = f"%{search}%"
        query += """ AND (
            p.title LIKE ? OR 
            p.prompt_text LIKE ? OR 
            p.system_prompt LIKE ? OR 
            p.tags LIKE ? OR 
            p.notes LIKE ? OR
            f.name LIKE ? OR
            pr.name LIKE ?
        )"""
        params.extend([search_term, search_term, search_term, search_term, search_term, search_term, search_term])

    if recent_only:
        query += " ORDER BY COALESCE(p.last_used_at, p.updated_at) DESC LIMIT 20"
    else:
        query += " ORDER BY p.is_favorite DESC, p.updated_at DESC"

    cursor.execute(query, params)
    rows = cursor.fetchall()
    
    results = []
    for r in rows:
        item = dict(r)
        try:
            item["variables"] = json.loads(item["variables"])
        except:
            item["variables"] = []
        try:
            item["tags"] = json.loads(item["tags"])
        except:
            item["tags"] = []
        results.append(item)

    conn.close()
    return results

def get_prompt_by_id(prompt_id: int, user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT p.*, f.name as folder_name, pr.name as project_name
    FROM prompts p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN projects pr ON p.project_id = pr.id
    WHERE p.id = ? AND p.user_id = ? AND p.is_deleted = 0
    """, (prompt_id, user_id))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    item = dict(row)
    try:
        item["variables"] = json.loads(item["variables"])
    except:
        item["variables"] = []
    try:
        item["tags"] = json.loads(item["tags"])
    except:
        item["tags"] = []
    return item

def check_duplicate_prompt(title: str, prompt_text: str, user_id: int = 1, exclude_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    query = "SELECT id, title, prompt_text FROM prompts WHERE user_id = ? AND is_deleted = 0"
    params = [user_id]
    if exclude_id:
        query += " AND id != ?"
        params.append(exclude_id)
    
    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    for r in rows:
        title_sim = difflib.SequenceMatcher(None, title.lower().strip(), r["title"].lower().strip()).ratio()
        text_sim = difflib.SequenceMatcher(None, prompt_text.lower().strip()[:200], r["prompt_text"].lower().strip()[:200]).ratio()
        
        if title_sim > 0.85 or text_sim > 0.85:
            return {
                "id": r["id"],
                "title": r["title"],
                "similarity_score": round(max(title_sim, text_sim) * 100),
                "reason": "Title matches closely" if title_sim > text_sim else "Prompt content matches closely"
            }
    return None

def create_prompt(data: Dict[str, Any], user_id: int = 1) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()

    variables = data.get("variables", [])
    if not isinstance(variables, str):
        variables = json.dumps(variables)

    tags = data.get("tags", [])
    if not isinstance(tags, str):
        tags = json.dumps(tags)

    cursor.execute("""
    INSERT INTO prompts (
        user_id, folder_id, project_id, title, category, ai_model, 
        system_prompt, prompt_text, variables, tags, notes, 
        is_favorite, copy_count, usage_count, current_version, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
    """, (
        user_id,
        data.get("folder_id"),
        data.get("project_id"),
        data.get("title", "Untitled Prompt"),
        data.get("category", "General"),
        data.get("ai_model", "General"),
        data.get("system_prompt", ""),
        data.get("prompt_text", ""),
        variables,
        tags,
        data.get("notes", ""),
        1 if data.get("is_favorite") else 0,
        now,
        now
    ))
    new_id = cursor.lastrowid

    # Create Initial Version Snapshot
    cursor.execute("""
    INSERT INTO prompt_versions (prompt_id, version_number, title, category, ai_model, system_prompt, prompt_text, variables, tags, notes, change_summary, created_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'Initial creation', ?)
    """, (
        new_id,
        data.get("title", "Untitled Prompt"),
        data.get("category", "General"),
        data.get("ai_model", "General"),
        data.get("system_prompt", ""),
        data.get("prompt_text", ""),
        variables,
        tags,
        data.get("notes", ""),
        now
    ))

    cat = data.get("category", "General")
    cursor.execute("INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, 'folder', 'indigo')", (cat,))
    
    conn.commit()
    conn.close()
    return get_prompt_by_id(new_id, user_id)

def update_prompt(prompt_id: int, data: Dict[str, Any], user_id: int = 1, change_summary: str = "Updated prompt") -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()

    cursor.execute("SELECT current_version FROM prompts WHERE id = ? AND user_id = ?", (prompt_id, user_id))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None
    
    current_ver = (row["current_version"] or 1) + 1

    variables = data.get("variables", [])
    if not isinstance(variables, str):
        variables = json.dumps(variables)

    tags = data.get("tags", [])
    if not isinstance(tags, str):
        tags = json.dumps(tags)

    cursor.execute("""
    UPDATE prompts
    SET folder_id = ?, project_id = ?, title = ?, category = ?, ai_model = ?, 
        system_prompt = ?, prompt_text = ?, variables = ?, tags = ?, notes = ?, 
        is_favorite = ?, current_version = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
    """, (
        data.get("folder_id"),
        data.get("project_id"),
        data.get("title"),
        data.get("category"),
        data.get("ai_model"),
        data.get("system_prompt", ""),
        data.get("prompt_text"),
        variables,
        tags,
        data.get("notes", ""),
        1 if data.get("is_favorite") else 0,
        current_ver,
        now,
        prompt_id,
        user_id
    ))

    cursor.execute("""
    INSERT INTO prompt_versions (prompt_id, version_number, title, category, ai_model, system_prompt, prompt_text, variables, tags, notes, change_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        prompt_id,
        current_ver,
        data.get("title"),
        data.get("category"),
        data.get("ai_model"),
        data.get("system_prompt", ""),
        data.get("prompt_text"),
        variables,
        tags,
        data.get("notes", ""),
        change_summary,
        now
    ))

    cat = data.get("category")
    if cat:
        cursor.execute("INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, 'folder', 'indigo')", (cat,))

    conn.commit()
    conn.close()
    return get_prompt_by_id(prompt_id, user_id)

def duplicate_prompt(prompt_id: int, user_id: int = 1) -> Optional[Dict[str, Any]]:
    original = get_prompt_by_id(prompt_id, user_id)
    if not original:
        return None

    new_data = dict(original)
    new_data["title"] = f"{original['title']} (Copy)"
    return create_prompt(new_data, user_id)

def move_prompt(prompt_id: int, folder_id: Optional[int], project_id: Optional[int] = None, user_id: int = 1) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    UPDATE prompts 
    SET folder_id = ?, project_id = COALESCE(?, project_id), updated_at = ?
    WHERE id = ? AND user_id = ?
    """, (folder_id, project_id, now, prompt_id, user_id))
    updated = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return updated

def record_prompt_usage(prompt_id: int, user_id: int = 1) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    UPDATE prompts 
    SET usage_count = usage_count + 1, copy_count = copy_count + 1, last_used_at = ?
    WHERE id = ? AND user_id = ?
    """, (now, prompt_id, user_id))
    conn.commit()
    cursor.execute("SELECT copy_count, usage_count, last_used_at FROM prompts WHERE id = ?", (prompt_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {}

def delete_prompt(prompt_id: int, user_id: int = 1) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM prompt_versions WHERE prompt_id = ?", (prompt_id,))
    cursor.execute("DELETE FROM prompts WHERE id = ? AND user_id = ?", (prompt_id, user_id))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted

# ==================== VERSION HISTORY OPERATIONS ====================

def get_prompt_history(prompt_id: int, user_id: int = 1) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT pv.* 
    FROM prompt_versions pv
    JOIN prompts p ON pv.prompt_id = p.id
    WHERE pv.prompt_id = ? AND p.user_id = ?
    ORDER BY pv.version_number DESC, pv.created_at DESC
    """, (prompt_id, user_id))
    rows = cursor.fetchall()
    
    versions = []
    for r in rows:
        item = dict(r)
        try:
            item["variables"] = json.loads(item["variables"])
        except:
            item["variables"] = []
        try:
            item["tags"] = json.loads(item["tags"])
        except:
            item["tags"] = []
        versions.append(item)

    conn.close()
    return versions

def restore_prompt_version(prompt_id: int, version_id: int, user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
    SELECT pv.* 
    FROM prompt_versions pv
    JOIN prompts p ON pv.prompt_id = p.id
    WHERE pv.id = ? AND pv.prompt_id = ? AND p.user_id = ?
    """, (version_id, prompt_id, user_id))
    target_version = cursor.fetchone()
    if not target_version:
        conn.close()
        return None

    target = dict(target_version)
    now = datetime.now().isoformat()

    cursor.execute("SELECT current_version FROM prompts WHERE id = ?", (prompt_id,))
    row = cursor.fetchone()
    new_ver_num = ((row["current_version"] or 1) if row else 1) + 1

    cursor.execute("""
    UPDATE prompts
    SET title = ?, category = ?, ai_model = ?, system_prompt = ?, prompt_text = ?,
        variables = ?, tags = ?, notes = ?, current_version = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
    """, (
        target["title"],
        target["category"],
        target["ai_model"],
        target["system_prompt"],
        target["prompt_text"],
        target["variables"],
        target["tags"],
        target["notes"],
        new_ver_num,
        now,
        prompt_id,
        user_id
    ))

    cursor.execute("""
    INSERT INTO prompt_versions (prompt_id, version_number, title, category, ai_model, system_prompt, prompt_text, variables, tags, notes, change_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        prompt_id,
        new_ver_num,
        target["title"],
        target["category"],
        target["ai_model"],
        target["system_prompt"],
        target["prompt_text"],
        target["variables"],
        target["tags"],
        target["notes"],
        f"Restored from version {target['version_number']}",
        now
    ))

    conn.commit()
    conn.close()
    return get_prompt_by_id(prompt_id, user_id)

def toggle_favorite(prompt_id: int, user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE prompts SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END WHERE id = ? AND user_id = ?", (prompt_id, user_id))
    conn.commit()
    conn.close()
    return get_prompt_by_id(prompt_id, user_id)

# ==================== FOLDERS & NESTED SUBFOLDERS ====================

def get_all_folders(user_id: int = 1, project_id: Optional[int] = None) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()

    query = """
    SELECT f.*, 
           COUNT(DISTINCT p.id) as prompt_count,
           COUNT(DISTINCT sub.id) as subfolder_count,
           pr.name as project_name,
           parent.name as parent_name
    FROM folders f
    LEFT JOIN prompts p ON f.id = p.folder_id AND p.is_deleted = 0
    LEFT JOIN folders sub ON f.id = sub.parent_id
    LEFT JOIN projects pr ON f.project_id = pr.id
    LEFT JOIN folders parent ON f.parent_id = parent.id
    WHERE f.user_id = ?
    """
    params = [user_id]
    if project_id is not None:
        query += " AND f.project_id = ?"
        params.append(project_id)

    query += " GROUP BY f.id ORDER BY f.parent_id ASC, f.position ASC, f.name ASC"

    cursor.execute(query, params)
    rows = cursor.fetchall()
    folders = [dict(r) for r in rows]
    conn.close()
    return folders

def get_folder_by_id(folder_id: int, user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT f.*, pr.name as project_name, parent.name as parent_name
    FROM folders f
    LEFT JOIN projects pr ON f.project_id = pr.id
    LEFT JOIN folders parent ON f.parent_id = parent.id
    WHERE f.id = ? AND f.user_id = ?
    """, (folder_id, user_id))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def create_folder(data: Dict[str, Any], user_id: int = 1) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    INSERT INTO folders (user_id, project_id, parent_id, name, icon, color, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        user_id,
        data.get("project_id"),
        data.get("parent_id"),
        data.get("name", "New Folder").strip(),
        data.get("icon", "folder"),
        data.get("color", "indigo"),
        data.get("position", 0),
        now,
        now
    ))
    new_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return get_folder_by_id(new_id, user_id)

def move_folder(folder_id: int, parent_id: Optional[int], project_id: Optional[int] = None, user_id: int = 1) -> bool:
    """Moves a folder into another folder (nested subfolder) or to root."""
    if parent_id == folder_id:
        return False
    
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    UPDATE folders
    SET parent_id = ?,
        project_id = COALESCE(?, project_id),
        updated_at = ?
    WHERE id = ? AND user_id = ?
    """, (parent_id, project_id, now, folder_id, user_id))
    updated = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return updated

def update_folder(folder_id: int, data: Dict[str, Any], user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    UPDATE folders
    SET name = COALESCE(?, name),
        parent_id = ?,
        project_id = ?,
        icon = COALESCE(?, icon),
        color = COALESCE(?, color),
        updated_at = ?
    WHERE id = ? AND user_id = ?
    """, (
        data.get("name"),
        data.get("parent_id"),
        data.get("project_id"),
        data.get("icon"),
        data.get("color"),
        now,
        folder_id,
        user_id
    ))
    conn.commit()
    conn.close()
    return get_folder_by_id(folder_id, user_id)

def delete_folder(folder_id: int, user_id: int = 1) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE prompts SET folder_id = NULL WHERE folder_id = ? AND user_id = ?", (folder_id, user_id))
    cursor.execute("DELETE FROM folders WHERE id = ? AND user_id = ?", (folder_id, user_id))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted

# ==================== PROJECTS OPERATIONS ====================

def get_all_projects(user_id: int = 1) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT pr.*, 
           COUNT(DISTINCT p.id) as prompt_count,
           COUNT(DISTINCT f.id) as folder_count
    FROM projects pr
    LEFT JOIN prompts p ON pr.id = p.project_id AND p.is_deleted = 0
    LEFT JOIN folders f ON pr.id = f.project_id
    WHERE pr.user_id = ?
    GROUP BY pr.id
    ORDER BY pr.updated_at DESC
    """, (user_id,))
    rows = cursor.fetchall()
    projects = [dict(r) for r in rows]
    conn.close()
    return projects

def get_project_by_id(project_id: int, user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT pr.*, 
           COUNT(DISTINCT p.id) as prompt_count,
           COUNT(DISTINCT f.id) as folder_count
    FROM projects pr
    LEFT JOIN prompts p ON pr.id = p.project_id AND p.is_deleted = 0
    LEFT JOIN folders f ON pr.id = f.project_id
    WHERE pr.id = ? AND pr.user_id = ?
    GROUP BY pr.id
    """, (project_id, user_id))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def create_project(data: Dict[str, Any], user_id: int = 1) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    INSERT INTO projects (user_id, name, client, description, category, icon, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        user_id,
        data.get("name", "New Project").strip(),
        data.get("client", "").strip(),
        data.get("description", "").strip(),
        data.get("category", "General"),
        data.get("icon", "briefcase"),
        data.get("color", "indigo"),
        now,
        now
    ))
    new_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return get_project_by_id(new_id, user_id)

def update_project(project_id: int, data: Dict[str, Any], user_id: int = 1) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()
    cursor.execute("""
    UPDATE projects
    SET name = COALESCE(?, name),
        client = COALESCE(?, client),
        description = COALESCE(?, description),
        category = COALESCE(?, category),
        icon = COALESCE(?, icon),
        color = COALESCE(?, color),
        updated_at = ?
    WHERE id = ? AND user_id = ?
    """, (
        data.get("name"),
        data.get("client"),
        data.get("description"),
        data.get("category"),
        data.get("icon"),
        data.get("color"),
        now,
        project_id,
        user_id
    ))
    conn.commit()
    conn.close()
    return get_project_by_id(project_id, user_id)

def delete_project(project_id: int, user_id: int = 1) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE prompts SET project_id = NULL WHERE project_id = ? AND user_id = ?", (project_id, user_id))
    cursor.execute("UPDATE folders SET project_id = NULL WHERE project_id = ? AND user_id = ?", (project_id, user_id))
    cursor.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted

# ==================== CATEGORIES OPERATIONS ====================

def get_all_categories() -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT c.*, COUNT(p.id) as prompt_count
    FROM categories c
    LEFT JOIN prompts p ON c.name = p.category AND p.is_deleted = 0
    GROUP BY c.id
    ORDER BY prompt_count DESC, c.name ASC
    """)
    rows = cursor.fetchall()
    cats = [dict(r) for r in rows]
    conn.close()
    return cats

def add_category(name: str, icon: str = "folder", color: str = "indigo") -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)", (name.strip(), icon, color))
    conn.commit()
    cursor.execute("SELECT * FROM categories WHERE name = ?", (name.strip(),))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {"name": name, "icon": icon, "color": color}

def delete_category(category_name: str) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM categories WHERE name = ?", (category_name,))
    cursor.execute("UPDATE prompts SET category = 'General' WHERE category = ?", (category_name,))
    conn.commit()
    conn.close()
    return True

# ==================== EXPORT & IMPORT ====================

def export_data(user_id: int = 1, folder_id: Optional[int] = None, project_id: Optional[int] = None) -> Dict[str, Any]:
    prompts = get_all_prompts(user_id=user_id, folder_id=folder_id, project_id=project_id)
    folders = get_all_folders(user_id=user_id, project_id=project_id)
    projects = get_all_projects(user_id=user_id)
    categories = get_all_categories()
    
    return {
        "app": "PromptVault Pro Enterprise",
        "version": "2.5.0",
        "exported_at": datetime.now().isoformat(),
        "total_prompts": len(prompts),
        "projects": projects,
        "folders": folders,
        "categories": categories,
        "prompts": prompts
    }

def import_data(payload: Dict[str, Any], user_id: int = 1) -> Dict[str, int]:
    prompts = payload.get("prompts", [])
    categories = payload.get("categories", [])
    folders = payload.get("folders", [])
    projects = payload.get("projects", [])
    
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.now().isoformat()

    for c in categories:
        name = c.get("name")
        if name:
            cursor.execute("INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)", 
                           (name, c.get("icon", "folder"), c.get("color", "indigo")))

    project_id_map = {}
    for pr in projects:
        old_id = pr.get("id")
        cursor.execute("""
        INSERT INTO projects (user_id, name, client, description, category, icon, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user_id, pr.get("name", "Imported Project"), pr.get("client", ""),
            pr.get("description", ""), pr.get("category", "General"),
            pr.get("icon", "briefcase"), pr.get("color", "indigo"), now, now
        ))
        if old_id:
            project_id_map[old_id] = cursor.lastrowid

    folder_id_map = {}
    for f in folders:
        old_id = f.get("id")
        mapped_project_id = project_id_map.get(f.get("project_id"))
        cursor.execute("""
        INSERT INTO folders (user_id, project_id, parent_id, name, icon, color, position, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
        """, (
            user_id, mapped_project_id, f.get("name", "Imported Folder"),
            f.get("icon", "folder"), f.get("color", "indigo"), f.get("position", 0), now, now
        ))
        if old_id:
            folder_id_map[old_id] = cursor.lastrowid

    imported_prompts_count = 0
    for p in prompts:
        title = p.get("title")
        prompt_text = p.get("prompt_text")
        if not title or not prompt_text:
            continue

        variables = p.get("variables", [])
        if not isinstance(variables, str):
            variables = json.dumps(variables)

        tags = p.get("tags", [])
        if not isinstance(tags, str):
            tags = json.dumps(tags)

        mapped_folder_id = folder_id_map.get(p.get("folder_id"))
        mapped_project_id = project_id_map.get(p.get("project_id"))

        cursor.execute("""
        INSERT INTO prompts (
            user_id, folder_id, project_id, title, category, ai_model,
            system_prompt, prompt_text, variables, tags, notes,
            is_favorite, copy_count, usage_count, current_version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (
            user_id, mapped_folder_id, mapped_project_id, title,
            p.get("category", "General"), p.get("ai_model", "General"),
            p.get("system_prompt", ""), prompt_text, variables, tags,
            p.get("notes", ""), 1 if p.get("is_favorite") else 0,
            p.get("copy_count", 0), p.get("usage_count", 0),
            p.get("created_at", now), p.get("updated_at", now)
        ))
        new_prompt_id = cursor.lastrowid

        cursor.execute("""
        INSERT INTO prompt_versions (prompt_id, version_number, title, category, ai_model, system_prompt, prompt_text, variables, tags, notes, change_summary, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'Imported from backup', ?)
        """, (
            new_prompt_id, title, p.get("category", "General"), p.get("ai_model", "General"),
            p.get("system_prompt", ""), prompt_text, variables, tags, p.get("notes", ""), now
        ))
        imported_prompts_count += 1

    conn.commit()
    conn.close()
    return {"imported_prompts": imported_prompts_count, "imported_folders": len(folders), "imported_projects": len(projects)}
