import json
import os
import threading
import urllib.parse
import urllib.request

import aiohttp
from aiohttp import web
from server import PromptServer

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "js"

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(NODE_DIR, "data")
TAGS_FILE = os.path.join(DATA_DIR, "danbooru.csv")
CONFIG_FILE = os.path.join(DATA_DIR, "file-sources.json")

# a1111-sd-webui-tagcomplete's danbooru.csv: tag,category,count,"aliases"
TAGS_URL = (
    "https://raw.githubusercontent.com/DominikDoom/"
    "a1111-sd-webui-tagcomplete/main/tags/danbooru.csv"
)


def _download_tags():
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(TAGS_FILE):
        print("[suggest-dt] Tags cache found, skipping download.")
        return
    print("[suggest-dt] Downloading danbooru.csv ...")
    try:
        urllib.request.urlretrieve(TAGS_URL, TAGS_FILE)
        with open(TAGS_FILE, encoding="utf-8") as f:
            count = sum(1 for _ in f)
        print(f"[suggest-dt] Tags loaded: {count} entries")
    except Exception as e:
        print(f"[suggest-dt] Failed to download tags: {e}")


threading.Thread(target=_download_tags, daemon=True).start()


def _load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"sources": []}


# ── Tag data ──────────────────────────────────────────────────────────────────

@PromptServer.instance.routes.get("/suggest-dt/tags")
async def get_tags(request):
    if not os.path.exists(TAGS_FILE):
        return web.Response(status=404, text="Tags not yet downloaded.")
    return web.FileResponse(TAGS_FILE)


# ── Wiki proxy (avoids CORS) ──────────────────────────────────────────────────

@PromptServer.instance.routes.get("/suggest-dt/wiki")
async def get_wiki(request):
    tag = request.query.get("tag", "").strip()
    if not tag:
        return web.Response(status=400, text="Missing tag parameter.")
    url = f"https://danbooru.donmai.us/wiki_pages/{urllib.parse.quote(tag)}.json"
    try:
        timeout = aiohttp.ClientTimeout(total=6)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status == 404:
                    return web.Response(status=404)
                if resp.status != 200:
                    return web.Response(status=resp.status)
                data = await resp.json(content_type=None)
                return web.json_response({"body": data.get("body", "")})
    except Exception as e:
        return web.Response(status=500, text=str(e))


# ── File sources ──────────────────────────────────────────────────────────────

@PromptServer.instance.routes.get("/suggest-dt/config")
async def get_config(request):
    return web.json_response(_load_config())


@PromptServer.instance.routes.post("/suggest-dt/config")
async def save_config(request):
    data = await request.json()
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return web.Response(status=200)


@PromptServer.instance.routes.get("/suggest-dt/files")
async def list_files(request):
    config = _load_config()
    result = []
    for source in config.get("sources", []):
        folder = source.get("folder", "").strip()
        prefix = source.get("prefix", "")
        suffix = source.get("suffix", "")
        if not folder or not os.path.isdir(folder):
            continue
        try:
            for fname in sorted(os.listdir(folder)):
                if fname.lower().endswith((".txt", ".yaml", ".yml")):
                    name = os.path.splitext(fname)[0]
                    result.append({"name": name, "prefix": prefix, "suffix": suffix})
        except OSError:
            pass
    return web.json_response(result)
