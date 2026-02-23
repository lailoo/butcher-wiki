"""
Butcher Wiki — Agent 工程组件切割机
FastAPI 后端入口
"""
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(
    title="Butcher Wiki",
    description="Agent 工程组件切割机 — 把开源项目大卸八块，提取可移植的工程组件",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "butcher-wiki"}


@app.get("/api/domains")
async def list_domains():
    """列出所有问题域"""
    from knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    return store.list_domains()


@app.get("/api/domains/{slug}")
async def get_domain(slug: str):
    """获取问题域详情 + 关联的解决方案"""
    from knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    return store.get_domain_detail(slug)


@app.get("/api/domains/{slug}/solutions")
async def get_solutions(slug: str):
    """获取某问题域下所有项目的解决方案"""
    from knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    return store.get_solutions(slug)


@app.get("/api/domains/{slug}/comparison")
async def get_comparison(slug: str):
    """获取某问题域的横向对比"""
    from knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    return store.get_comparison(slug)


@app.get("/api/projects")
async def list_projects():
    """列出所有已分析的开源项目"""
    from knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    return store.list_projects()


@app.get("/api/projects/{slug}")
async def get_project(slug: str):
    """获取项目详情 + 它贡献了哪些问题域的解决方案"""
    from knowledge_store import KnowledgeStore
    store = KnowledgeStore()
    return store.get_project_detail(slug)


@app.websocket("/ws/scan")
async def scan_repo(websocket: WebSocket):
    """WebSocket: 扫描新仓库，实时推送提取进度"""
    await websocket.accept()
    data = await websocket.receive_json()
    repo_url = data.get("repo_url")

    from scanner import RepoScanner
    scanner = RepoScanner(websocket)
    await scanner.scan(repo_url)
    await websocket.close()


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
