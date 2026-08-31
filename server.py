import re
import os
import io
import csv
import json
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, APIRouter, HTTPException, Query, UploadFile, File, Response
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import database
import apk_builder

# Variable regex: detects {{variable_name}}, [variable_name], or {variable_name}
VAR_REGEX = re.compile(r"\{\{([a-zA-Z0-9_\-\s]+)\}\}|\[([a-zA-Z0-9_\-\s]+)\]|\{([a-zA-Z0-9_\-\s]+)\}")

def extract_variables(text: str) -> List[str]:
    matches = VAR_REGEX.findall(text)
    vars_found = set()
    for m in matches:
        var = m[0] or m[1] or m[2]
        var = var.strip()
        if var and len(var) < 40:
            vars_found.add(var)
    return list(vars_found)

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        database.init_db()
    except Exception as e:
        print("[Lifespan Warning] DB init:", e)
    try:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        static_dir = os.path.join(base_dir, "static")
        if os.access(base_dir, os.W_OK):
            apk_builder.generate_mobile_assets(static_dir)
            apk_out = os.path.join(static_dir, "promptvault.apk")
            if not os.path.exists(apk_out):
                apk_builder.build_standalone_apk(apk_out, static_dir)
    except Exception as e:
        print("[Lifespan Warning] APK build skipped:", e)
    yield

app = FastAPI(title="PromptVault Pro Enterprise API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter()

# ==================== PYDANTIC SCHEMAS ====================

class PromptCreateRequest(BaseModel):
    title: str = Field(..., min_length=1)
    folder_id: Optional[int] = None
    project_id: Optional[int] = None
    category: str = "General"
    ai_model: str = "General"
    system_prompt: Optional[str] = ""
    prompt_text: str = Field(..., min_length=1)
    variables: Optional[List[str]] = []
    tags: Optional[List[str]] = []
    notes: Optional[str] = ""
    is_favorite: Optional[bool] = False

class PromptUpdateRequest(BaseModel):
    title: Optional[str] = None
    folder_id: Optional[int] = None
    project_id: Optional[int] = None
    category: Optional[str] = None
    ai_model: Optional[str] = None
    system_prompt: Optional[str] = None
    prompt_text: Optional[str] = None
    variables: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    notes: Optional[str] = None
    is_favorite: Optional[bool] = None
    change_summary: Optional[str] = "Manual update"

class PromptMoveRequest(BaseModel):
    folder_id: Optional[int] = None
    project_id: Optional[int] = None

class DuplicateCheckRequest(BaseModel):
    title: str
    prompt_text: str
    exclude_id: Optional[int] = None

class FolderCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    parent_id: Optional[int] = None
    project_id: Optional[int] = None
    color: Optional[str] = "amber"
    icon: Optional[str] = "folder"
    description: Optional[str] = ""

class FolderUpdateRequest(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[int] = None
    project_id: Optional[int] = None
    color: Optional[str] = None
    icon: Optional[str] = None
    description: Optional[str] = None

class FolderMoveRequest(BaseModel):
    parent_id: Optional[int] = None
    project_id: Optional[int] = None

class ProjectCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    client: Optional[str] = ""
    color: Optional[str] = "indigo"
    description: Optional[str] = ""

class ProjectUpdateRequest(BaseModel):
    name: Optional[str] = None
    client: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None

class CategoryCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    icon: Optional[str] = "folder"
    color: Optional[str] = "indigo"

class SyncPayload(BaseModel):
    prompts: Optional[List[Dict[str, Any]]] = []
    folders: Optional[List[Dict[str, Any]]] = []
    projects: Optional[List[Dict[str, Any]]] = []

# ==================== PROMPTS ROUTES ====================

@api.get("/prompts")
def get_prompts(
    category: Optional[str] = Query(None),
    folder_id: Optional[int] = Query(None),
    project_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    favorite: Optional[bool] = Query(False),
    recent: Optional[bool] = Query(False),
    model: Optional[str] = Query(None)
):
    prompts = database.get_all_prompts(
        user_id=1,
        category=category,
        folder_id=folder_id,
        project_id=project_id,
        search=search,
        favorite_only=favorite or False,
        model=model,
        recent_only=recent or False
    )
    return {"status": "success", "count": len(prompts), "data": prompts}

@api.get("/prompts/{prompt_id}")
def get_prompt(prompt_id: int):
    prompt = database.get_prompt_by_id(prompt_id, user_id=1)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"status": "success", "data": prompt}

@api.post("/prompts/check-duplicate")
def check_duplicate(req: DuplicateCheckRequest):
    duplicate = database.check_duplicate_prompt(
        title=req.title,
        prompt_text=req.prompt_text,
        user_id=1,
        exclude_id=req.exclude_id
    )
    return {"status": "success", "duplicate": duplicate}

@api.post("/prompts")
def create_prompt(item: PromptCreateRequest):
    try:
        data = item.model_dump()
        if not data.get("variables"):
            data["variables"] = extract_variables(data["prompt_text"])

        created = database.create_prompt(data, user_id=1)
        return {"status": "success", "data": created}
    except Exception as e:
        print("[Error] create_prompt:", e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@api.put("/prompts/{prompt_id}")
def update_prompt(prompt_id: int, item: PromptUpdateRequest):
    existing = database.get_prompt_by_id(prompt_id, user_id=1)
    if not existing:
        raise HTTPException(status_code=404, detail="Prompt not found")

    data = item.model_dump()
    change_summary = data.pop("change_summary", "Manual update")
    if data.get("variables") is None:
        data["variables"] = extract_variables(data["prompt_text"])

    updated = database.update_prompt(prompt_id, data, user_id=1, change_summary=change_summary)
    return {"status": "success", "data": updated}

@api.post("/prompts/{prompt_id}/duplicate")
def duplicate_prompt(prompt_id: int):
    duplicated = database.duplicate_prompt(prompt_id, user_id=1)
    if not duplicated:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"status": "success", "data": duplicated}

@api.post("/prompts/{prompt_id}/move")
def move_prompt(prompt_id: int, req: PromptMoveRequest):
    success = database.move_prompt(prompt_id, folder_id=req.folder_id, project_id=req.project_id, user_id=1)
    if not success:
        raise HTTPException(status_code=404, detail="Prompt not found")
    updated = database.get_prompt_by_id(prompt_id, user_id=1)
    return {"status": "success", "data": updated}

@api.post("/prompts/{prompt_id}/use")
def use_prompt(prompt_id: int):
    stats = database.record_prompt_usage(prompt_id, user_id=1)
    return {"status": "success", "data": stats}

@api.post("/prompts/{prompt_id}/favorite")
def toggle_favorite(prompt_id: int):
    updated = database.toggle_favorite(prompt_id, user_id=1)
    if not updated:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"status": "success", "data": updated}

@api.delete("/prompts/{prompt_id}")
def delete_prompt(prompt_id: int):
    success = database.delete_prompt(prompt_id, user_id=1)
    if not success:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"status": "success", "message": "Prompt deleted successfully"}

# ==================== VERSION HISTORY ROUTES ====================

@api.get("/prompts/{prompt_id}/history")
def get_prompt_history(prompt_id: int):
    existing = database.get_prompt_by_id(prompt_id, user_id=1)
    if not existing:
        raise HTTPException(status_code=404, detail="Prompt not found")
    history = database.get_prompt_history(prompt_id, user_id=1)
    return {"status": "success", "prompt_id": prompt_id, "count": len(history), "data": history}

@api.post("/prompts/{prompt_id}/restore/{version_id}")
def restore_prompt_version(prompt_id: int, version_id: int):
    restored = database.restore_prompt_version(prompt_id, version_id, user_id=1)
    if not restored:
        raise HTTPException(status_code=404, detail="Version or Prompt not found")
    return {"status": "success", "message": f"Successfully restored to version {version_id}", "data": restored}

# ==================== FOLDERS ROUTES ====================

@api.get("/folders")
def get_folders(project_id: Optional[int] = Query(None)):
    folders = database.get_all_folders(user_id=1, project_id=project_id)
    return {"status": "success", "count": len(folders), "data": folders}

@api.post("/folders")
def create_folder(item: FolderCreateRequest):
    folder = database.create_folder(item.model_dump(), user_id=1)
    return {"status": "success", "data": folder}

@api.post("/folders/{folder_id}/move")
def move_folder(folder_id: int, req: FolderMoveRequest):
    success = database.move_folder(folder_id, parent_id=req.parent_id, project_id=req.project_id, user_id=1)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot move folder into itself or non-existent folder")
    updated = database.get_folder_by_id(folder_id, user_id=1)
    return {"status": "success", "data": updated}

@api.put("/folders/{folder_id}")
def update_folder(folder_id: int, item: FolderUpdateRequest):
    updated = database.update_folder(folder_id, item.model_dump(exclude_unset=True), user_id=1)
    if not updated:
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"status": "success", "data": updated}

@api.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: int,
    prompt_action: str = Query("uncategorize", enum=["uncategorize", "move", "delete"]),
    target_folder_id: Optional[int] = Query(None)
):
    success = database.delete_folder(
        folder_id=folder_id,
        prompt_action=prompt_action,
        target_folder_id=target_folder_id,
        user_id=1
    )
    if not success:
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"status": "success", "message": "Folder deleted successfully"}

# ==================== PROJECTS ROUTES ====================

@api.get("/projects")
def get_projects():
    projects = database.get_all_projects(user_id=1)
    return {"status": "success", "count": len(projects), "data": projects}

@api.post("/projects")
def create_project(item: ProjectCreateRequest):
    project = database.create_project(item.model_dump(), user_id=1)
    return {"status": "success", "data": project}

@api.put("/projects/{project_id}")
def update_project(project_id: int, item: ProjectUpdateRequest):
    updated = database.update_project(project_id, item.model_dump(exclude_unset=True), user_id=1)
    if not updated:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"status": "success", "data": updated}

@api.delete("/projects/{project_id}")
def delete_project(project_id: int):
    success = database.delete_project(project_id, user_id=1)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"status": "success", "message": "Project deleted successfully"}

# ==================== CATEGORIES ROUTES ====================

@api.get("/categories")
def get_categories():
    categories = database.get_all_categories()
    return {"status": "success", "data": categories}

@api.post("/categories")
def create_category(item: CategoryCreateRequest):
    cat = database.add_category(item.name, item.icon or "folder", item.color or "indigo")
    return {"status": "success", "data": cat}

@api.delete("/categories/{name}")
def remove_category(name: str):
    database.delete_category(name)
    return {"status": "success", "message": f"Category {name} deleted"}

# ==================== STATS & BACKUP ====================

@api.get("/stats")
def get_stats():
    prompts = database.get_all_prompts(user_id=1)
    folders = database.get_all_folders(user_id=1)
    projects = database.get_all_projects(user_id=1)
    categories = database.get_all_categories()
    
    total = len(prompts)
    favorites = sum(1 for p in prompts if p.get("is_favorite") == 1)
    total_copies = sum(p.get("copy_count", 0) for p in prompts)
    total_uses = sum(p.get("usage_count", 0) for p in prompts)
    
    models = {}
    for p in prompts:
        m = p.get("ai_model", "General")
        models[m] = models.get(m, 0) + 1

    return {
        "status": "success",
        "total_prompts": total,
        "total_folders": len(folders),
        "total_projects": len(projects),
        "total_favorites": favorites,
        "total_copies": total_copies,
        "total_uses": total_uses,
        "categories_count": len(categories),
        "models_distribution": models
    }

@api.get("/export")
def export_backup(
    format: str = Query("json", enum=["json", "csv"]),
    folder_id: Optional[int] = Query(None),
    project_id: Optional[int] = Query(None)
):
    data = database.export_data(user_id=1, folder_id=folder_id, project_id=project_id)
    
    if format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["ID", "Title", "Category", "Folder", "Project", "AI Model", "System Prompt", "Prompt Text", "Variables", "Tags", "Notes", "Favorite", "Copy Count", "Usage Count", "Created At"])
        for p in data["prompts"]:
            writer.writerow([
                p.get("id"),
                p.get("title"),
                p.get("category"),
                p.get("folder_name", ""),
                p.get("project_name", ""),
                p.get("ai_model"),
                p.get("system_prompt", ""),
                p.get("prompt_text"),
                ", ".join(p.get("variables", [])),
                ", ".join(p.get("tags", [])),
                p.get("notes", ""),
                p.get("is_favorite"),
                p.get("copy_count"),
                p.get("usage_count"),
                p.get("created_at")
            ])
        return Response(
            content=output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=promptvault_prompts.csv"}
        )

    return JSONResponse(
        content=data,
        headers={"Content-Disposition": "attachment; filename=promptvault_backup.json"}
    )

@api.post("/import")
async def import_backup(file: UploadFile = File(...)):
    try:
        content = await file.read()
        payload = json.loads(content.decode("utf-8"))
        result = database.import_data(payload, user_id=1)
        return {"status": "success", "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid backup file format: {str(e)}")

@api.post("/import/csv")
async def import_csv(file: UploadFile = File(...)):
    try:
        content = await file.read()
        decoded = content.decode("utf-8")
        reader = csv.DictReader(io.StringIO(decoded))
        imported_count = 0
        for row in reader:
            title = row.get("Title") or row.get("title")
            prompt_text = row.get("Prompt Text") or row.get("prompt_text")
            if not title or not prompt_text:
                continue
            
            p_data = {
                "title": title,
                "category": row.get("Category") or row.get("category") or "General",
                "ai_model": row.get("AI Model") or row.get("ai_model") or "General",
                "system_prompt": row.get("System Prompt") or row.get("system_prompt") or "",
                "prompt_text": prompt_text,
                "notes": row.get("Notes") or row.get("notes") or "",
                "is_favorite": True if row.get("Favorite") in ["1", "true", "True"] else False
            }
            database.create_prompt(p_data, user_id=1)
            imported_count += 1
        return {"status": "success", "imported_prompts": imported_count}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid CSV format: {str(e)}")

# ==================== SYNC & OFFLINE ENDPOINT ====================

@api.post("/sync")
def sync_data(payload: SyncPayload):
    synced_prompts = 0
    synced_folders = 0

    if payload.folders:
        for f in payload.folders:
            if not f.get("id") or str(f.get("id")).startswith("temp_"):
                database.create_folder(f, user_id=1)
                synced_folders += 1

    if payload.prompts:
        for p in payload.prompts:
            if not p.get("id") or str(p.get("id")).startswith("temp_"):
                database.create_prompt(p, user_id=1)
                synced_prompts += 1

    return {
        "status": "success",
        "synced_prompts": synced_prompts,
        "synced_folders": synced_folders,
        "server_prompts": database.get_all_prompts(user_id=1),
        "server_folders": database.get_all_folders(user_id=1),
        "server_projects": database.get_all_projects(user_id=1)
    }

# ==================== MOBILE APK DOWNLOAD ====================

@api.get("/download/promptvault.apk")
def download_apk():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    apk_path = os.path.join(base_dir, "static", "promptvault.apk")
    if not os.path.exists(apk_path):
        tmp_apk = "/tmp/promptvault.apk"
        if not os.path.exists(tmp_apk):
            try:
                static_dir = os.path.join(base_dir, "static")
                apk_builder.build_standalone_apk(tmp_apk, static_dir)
            except Exception:
                pass
        if os.path.exists(tmp_apk):
            apk_path = tmp_apk

    if os.path.exists(apk_path):
        return FileResponse(
            path=apk_path,
            filename="promptvault-v2.5.apk",
            media_type="application/vnd.android.package-archive"
        )
    return JSONResponse({"status": "error", "message": "APK generating"}, status_code=202)

# Include Router with both /api prefix and root prefix
app.include_router(api, prefix="/api")
app.include_router(api, prefix="")

# Static Files
base_dir = os.path.dirname(os.path.abspath(__file__))
static_dir = os.path.join(base_dir, "static")
if not os.path.exists(static_dir):
    parent_static = os.path.join(os.path.dirname(base_dir), "static")
    if os.path.exists(parent_static):
        static_dir = parent_static

@app.get("/")
def serve_index():
    index_file = os.path.join(static_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file, media_type="text/html")
    return HTMLResponse("<h1>PromptVault Pro Enterprise</h1>")

if os.path.exists(static_dir):
    try:
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    except Exception as e:
        print("[Warning] StaticFiles mount:", e)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"🚀 Starting PromptVault Pro Server on http://0.0.0.0:{port}")
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
